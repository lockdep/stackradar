import { eq, and, inArray } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import type { Component, NewComponent } from "../db/schema/components.js";
import type { License, NewLicense } from "../db/schema/licenses.js";
import type { NewComponentHash } from "../db/schema/component-hashes.js";
import type { NewComponentExternalRef } from "../db/schema/component-external-refs.js";
import type { NewComponentProperty } from "../db/schema/component-properties.js";
import { collapsedFindings } from "../db/findings.js";

const BATCH_CHUNK_SIZE = 500;

export type ComponentWithDetails = Component & {
    license: string | null;
    vulnerabilities: { id: string; severity: string | null }[];
    packageType: string | null;
    packageLanguage: string | null;
    location: string | null;
};

/**
 * The findings on these components — the same set, under the same rules, that
 * the Vulnerabilities tab lists.
 *
 * Scoped by component id rather than by image, so it deliberately does not
 * re-assert "current SBOM": the callers have already resolved the component
 * list from the current SBOM, and a second copy of that rule here is a second
 * place for it to change.
 */
async function findingsForComponents(
    componentIds: string[],
): Promise<{ componentId: string; vulnId: string; severityLevel: string | null }[]> {
    const findings = collapsedFindings(inArray(schema.components.id, componentIds));
    return db
        .select({
            componentId: findings.componentId,
            vulnId: findings.vulnId,
            severityLevel: findings.severityLevel,
        })
        .from(findings);
}

export const componentRepository = {
    async findById(id: string): Promise<Component | undefined> {
        const results = await db.select().from(schema.components).where(eq(schema.components.id, id));
        return results[0];
    },

    async findBySbomId(sbomId: string): Promise<Component[]> {
        return db.select().from(schema.components).where(eq(schema.components.sbomId, sbomId));
    },

    async findLibrariesBySbomId(sbomId: string): Promise<Component[]> {
        return db
            .select()
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.type, "library")));
    },

    /**
     * Find all library components for an image's SBOM.
     * Only returns components with type 'library'.
     *
     * No `isCurrent` filter and no `LIMIT 1` tie-breaker: `sboms_image_id_unique`
     * makes "the image's SBOM" singular, so there is nothing left to
     * disambiguate.
     */
    async findByImageIdCurrent(imageId: string): Promise<Component[]> {
        const sbom = await db
            .select({ id: schema.sboms.id })
            .from(schema.sboms)
            .where(eq(schema.sboms.imageId, imageId));

        if (sbom.length === 0) return [];

        return db
            .select()
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbom[0]!.id), eq(schema.components.type, "library")));
    },

    /**
     * Find all library components for a specific SBOM with license, vulnerability, and property info.
     */
    async findBySbomIdWithDetails(sbomId: string): Promise<ComponentWithDetails[]> {
        const components = await db
            .select()
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.type, "library")));

        if (components.length === 0) {
            return [];
        }

        const componentIds = components.map((c) => c.id);

        const SYFT_PROP_NAMES = ["syft:package:type", "syft:package:language", "syft:location:0:path"];

        const [licensesResult, vulnsResult, propsResult] = await Promise.all([
            db
                .select({
                    componentId: schema.componentLicenses.componentId,
                    spdxId: schema.licenses.spdxId,
                    name: schema.licenses.name,
                    expression: schema.licenses.expression,
                })
                .from(schema.componentLicenses)
                .innerJoin(schema.licenses, eq(schema.componentLicenses.licenseId, schema.licenses.id))
                .where(inArray(schema.componentLicenses.componentId, componentIds)),
            findingsForComponents(componentIds),
            db
                .select({
                    componentId: schema.componentProperties.componentId,
                    name: schema.componentProperties.name,
                    value: schema.componentProperties.value,
                })
                .from(schema.componentProperties)
                .where(
                    and(
                        inArray(schema.componentProperties.componentId, componentIds),
                        inArray(schema.componentProperties.name, SYFT_PROP_NAMES),
                    ),
                ),
        ]);

        const propsMap = new Map<
            string,
            { packageType: string | null; packageLanguage: string | null; location: string | null }
        >();
        for (const prop of propsResult) {
            if (!propsMap.has(prop.componentId)) {
                propsMap.set(prop.componentId, { packageType: null, packageLanguage: null, location: null });
            }
            const entry = propsMap.get(prop.componentId)!;
            if (prop.name === "syft:package:type") entry.packageType = prop.value;
            else if (prop.name === "syft:package:language") entry.packageLanguage = prop.value;
            else if (prop.name === "syft:location:0:path") entry.location = prop.value;
        }

        const licenseMap = new Map<string, string>();
        for (const lic of licensesResult) {
            if (!licenseMap.has(lic.componentId)) {
                licenseMap.set(lic.componentId, lic.spdxId ?? lic.expression ?? lic.name ?? "Unknown");
            }
        }

        const vulnMap = new Map<string, { id: string; severity: string | null }[]>();
        for (const vuln of vulnsResult) {
            if (!vulnMap.has(vuln.componentId)) {
                vulnMap.set(vuln.componentId, []);
            }
            vulnMap.get(vuln.componentId)!.push({
                id: vuln.vulnId,
                severity: vuln.severityLevel,
            });
        }

        return components.map((comp) => {
            const props = propsMap.get(comp.id);
            return {
                ...comp,
                license: licenseMap.get(comp.id) ?? null,
                vulnerabilities: vulnMap.get(comp.id) ?? [],
                packageType: props?.packageType ?? null,
                packageLanguage: props?.packageLanguage ?? null,
                location: props?.location ?? null,
            };
        });
    },

    /**
     * Lean version of findBySbomIdWithDetails for endpoints that only need component
     * metadata + syft properties (no licenses, no vulnerability counts).
     * Two queries instead of four; skips large columns.
     */
    async findLeanMetaBySbomId(sbomId: string): Promise<
        {
            id: string;
            name: string;
            version: string | null;
            isDirect: boolean | null;
            packageType: string | null;
            location: string | null;
        }[]
    > {
        const components = await db
            .select({
                id: schema.components.id,
                name: schema.components.name,
                version: schema.components.version,
                isDirect: schema.components.isDirect,
            })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.type, "library")));

        if (components.length === 0) return [];

        const componentIds = components.map((c) => c.id);
        const propsResult = await db
            .select({
                componentId: schema.componentProperties.componentId,
                name: schema.componentProperties.name,
                value: schema.componentProperties.value,
            })
            .from(schema.componentProperties)
            .where(
                and(
                    inArray(schema.componentProperties.componentId, componentIds),
                    inArray(schema.componentProperties.name, ["syft:package:type", "syft:location:0:path"]),
                ),
            );

        const propsMap = new Map<string, { packageType: string | null; location: string | null }>();
        for (const prop of propsResult) {
            if (!propsMap.has(prop.componentId)) {
                propsMap.set(prop.componentId, { packageType: null, location: null });
            }
            const entry = propsMap.get(prop.componentId)!;
            if (prop.name === "syft:package:type") entry.packageType = prop.value;
            else if (prop.name === "syft:location:0:path") entry.location = prop.value;
        }

        return components.map((c) => {
            const props = propsMap.get(c.id);
            return {
                ...c,
                packageType: props?.packageType ?? null,
                location: props?.location ?? null,
            };
        });
    },

    /**
     * Every component of every stored SBOM. Used for periodic vulnerability
     * re-syncing.
     *
     * "Current" has no meaning here any more — one SBOM per image, and an image
     * is immutable — so this is simply every component, deduplicated by image
     * rather than repeated once per workload that runs it.
     */
    async findAllFromCurrentSboms(): Promise<Component[]> {
        return db
            .select({
                id: schema.components.id,
                sbomId: schema.components.sbomId,
                purl: schema.components.purl,
                name: schema.components.name,
                version: schema.components.version,
                type: schema.components.type,
                groupName: schema.components.groupName,
                publisher: schema.components.publisher,
                author: schema.components.author,
                description: schema.components.description,
                cpe: schema.components.cpe,
                bomRef: schema.components.bomRef,
                isDirect: schema.components.isDirect,
                scope: schema.components.scope,
                tier: schema.components.tier,
                layerIndex: schema.components.layerIndex,
                fromBase: schema.components.fromBase,
                tierVersion: schema.components.tierVersion,
                createdAt: schema.components.createdAt,
                updatedAt: schema.components.updatedAt,
            })
            .from(schema.components)
            .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id));
    },

    /**
     * Batch insert components. No deduplication -- each SBOM gets its own component rows.
     */
    async batchCreate(components: NewComponent[], tx?: Transaction): Promise<Component[]> {
        if (components.length === 0) return [];

        const q = tx ?? db;
        const results: Component[] = [];
        for (let i = 0; i < components.length; i += BATCH_CHUNK_SIZE) {
            const chunk = components.slice(i, i + BATCH_CHUNK_SIZE);
            const created = await q.insert(schema.components).values(chunk).returning();
            results.push(...created);
        }
        return results;
    },

    // Hash operations
    async batchAddAllHashes(hashes: NewComponentHash[], tx?: Transaction): Promise<void> {
        if (hashes.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < hashes.length; i += BATCH_CHUNK_SIZE) {
            const chunk = hashes.slice(i, i + BATCH_CHUNK_SIZE);
            await q.insert(schema.componentHashes).values(chunk).onConflictDoNothing();
        }
    },

    // External reference operations
    async batchAddAllExternalRefs(refs: NewComponentExternalRef[], tx?: Transaction): Promise<void> {
        if (refs.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < refs.length; i += BATCH_CHUNK_SIZE) {
            const chunk = refs.slice(i, i + BATCH_CHUNK_SIZE);
            await q.insert(schema.componentExternalRefs).values(chunk);
        }
    },

    // Property operations
    async batchAddComponentProperties(properties: NewComponentProperty[], tx?: Transaction): Promise<void> {
        if (properties.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < properties.length; i += BATCH_CHUNK_SIZE) {
            const chunk = properties.slice(i, i + BATCH_CHUNK_SIZE);
            await q.insert(schema.componentProperties).values(chunk);
        }
    },

    /**
     * Batch find-or-create licenses. Deduplicates by spdxId/name/expression.
     */
    async batchFindOrCreateLicenses(licenses: NewLicense[], tx?: Transaction): Promise<Map<string, License>> {
        if (licenses.length === 0) return new Map();

        const q = tx ?? db;
        const result = new Map<string, License>();

        const unique = new Map<string, NewLicense>();
        for (const lic of licenses) {
            const key = lic.spdxId ?? lic.expression ?? lic.name ?? "";
            if (key && !unique.has(key)) {
                unique.set(key, lic);
            }
        }

        const spdxIds = [...unique.values()].filter((l) => l.spdxId).map((l) => l.spdxId!);

        if (spdxIds.length > 0) {
            const existing = await q.select().from(schema.licenses).where(inArray(schema.licenses.spdxId, spdxIds));

            for (const lic of existing) {
                if (lic.spdxId) {
                    result.set(lic.spdxId, lic);
                    unique.delete(lic.spdxId);
                }
            }
        }

        const toCreate = [...unique.entries()];
        if (toCreate.length > 0) {
            for (let i = 0; i < toCreate.length; i += BATCH_CHUNK_SIZE) {
                const chunk = toCreate.slice(i, i + BATCH_CHUNK_SIZE);
                const created = await q
                    .insert(schema.licenses)
                    .values(chunk.map(([, lic]) => lic))
                    .returning();

                for (let j = 0; j < created.length; j++) {
                    const key = chunk[j]![0];
                    result.set(key, created[j]!);
                }
            }
        }

        return result;
    },

    /**
     * Batch link components to licenses.
     */
    async batchLinkComponentLicenses(
        links: Array<{ componentId: string; licenseId: string }>,
        tx?: Transaction,
    ): Promise<void> {
        if (links.length === 0) return;

        const q = tx ?? db;
        for (let i = 0; i < links.length; i += BATCH_CHUNK_SIZE) {
            const chunk = links.slice(i, i + BATCH_CHUNK_SIZE);
            await q.insert(schema.componentLicenses).values(chunk).onConflictDoNothing();
        }
    },
};
