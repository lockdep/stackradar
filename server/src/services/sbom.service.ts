import {
    Models,
    Enums,
    Spec,
    Serialize,
    Validation,
} from "@cyclonedx/cyclonedx-library";
import { createHash } from "crypto";
import { PackageURL } from "packageurl-js";
import { sbomRepository, componentRepository } from "../repositories/index.js";
import { eq } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import { deleteSbomSubtreeInTx } from "../repositories/delete-helpers.js";
import { isUniqueViolationOn } from "../lib/pg-errors.js";
import { AppError } from "../middleware/error-handler.js";
import { applyTierRules, classifyFromProperties, TIER_VERSION, type TierRule } from "../lib/component-tier.js";
import { detectMainComponent, mainCandidateOf, narrowMain } from "../lib/main-component.js";
import { tierRulesForOrg } from "./tier-rules.service.js";
import { layerIndexByDiffId, parseImageMetadata, resolveLayerIndex } from "../lib/image-layers.js";
import { imageLayerRepository } from "../repositories/image-layer.repository.js";
import { resolveBaseForImage } from "./base-image.service.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("sbom.service");
import type { Sbom } from "../db/schema/sboms.js";
import type { Component, NewComponent, ComponentScope } from "../db/schema/components.js";
import type { NewComponentHash } from "../db/schema/component-hashes.js";
import type { NewComponentExternalRef } from "../db/schema/component-external-refs.js";
import type { NewComponentProperty } from "../db/schema/component-properties.js";
import type { NewLicense } from "../db/schema/licenses.js";

const DEFAULT_SPEC_VERSION = Spec.Version.v1dot6;

/**
 * The only SBOM format we ingest.
 *
 * Kept as a named type rather than an inline literal because `format` is part
 * of the API response contract and the `sboms.format` column, both of which
 * outlive this file. Widen it only alongside a real second parser — see
 * `docs/osv-matcher-upstream-comparison.md` for why a second format should
 * arrive as an edge converter into this model, not as a parallel pipeline.
 */
export type SbomFormat = "cyclonedx";

/**
 * Computes SHA-256 hash of the SBOM content for deduplication
 */
function computeSbomHash(data: unknown): string {
    const json = JSON.stringify(data, Object.keys(data as object).sort());
    return createHash("sha256").update(json).digest("hex");
}

/**
 * Guard the service entry point against anything that isn't CycloneDX.
 *
 * Callers reaching this through `POST /v1/sboms/upload/cyclonedx` have already
 * been validated against the CycloneDX 1.6 JSON schema by the controller, so
 * this is defence in depth for any future non-HTTP caller (a worker, a
 * backfill) that skips that step.
 */
function assertCycloneDx(data: unknown): asserts data is Record<string, unknown> {
    if (typeof data !== "object" || data === null) {
        throw new Error("Invalid SBOM: must be an object");
    }

    if ((data as Record<string, unknown>).bomFormat !== "CycloneDX") {
        throw new Error("Invalid SBOM: expected a CycloneDX document (bomFormat: \"CycloneDX\")");
    }
}

/**
 * Maps a component type string to the library's enum
 */
function toComponentType(type: string): Enums.ComponentType {
    return (Object.values(Enums.ComponentType) as string[]).includes(type)
        ? (type as Enums.ComponentType)
        : Enums.ComponentType.Library;
}

/**
 * Safely parses a PURL string into a PackageURL object
 */
function parsePurl(purl: string): PackageURL | undefined {
    try {
        return PackageURL.fromString(purl);
    } catch {
        return undefined;
    }
}

interface ParsedHash {
    algorithm: string;
    value: string;
}

interface ParsedExternalRef {
    type: string;
    url: string;
    comment?: string | undefined;
}

/**
 * Extended component data with raw fields not in the library model
 */
interface ExtendedComponentData {
    component: Models.Component;
    scope?: string | undefined;
    hashes: ParsedHash[];
    externalRefs: ParsedExternalRef[];
}

/**
 * Parses a raw component object into a library Component model with extended data
 */
function parseComponent(raw: Record<string, unknown>): ExtendedComponentData {
    const type = toComponentType(String(raw.type ?? "library"));
    const name = String(raw.name ?? "unknown");

    const options: Models.OptionalComponentProperties = {};

    if (raw["bom-ref"] && typeof raw["bom-ref"] === "string") {
        options.bomRef = raw["bom-ref"];
    }
    if (raw.version && typeof raw.version === "string") {
        options.version = raw.version;
    }
    if (raw.group && typeof raw.group === "string") {
        options.group = raw.group;
    }
    if (raw.description && typeof raw.description === "string") {
        options.description = raw.description;
    }
    if (raw.author && typeof raw.author === "string") {
        options.author = raw.author;
    }
    if (raw.publisher && typeof raw.publisher === "string") {
        options.publisher = raw.publisher;
    }
    if (raw.purl && typeof raw.purl === "string") {
        options.purl = parsePurl(raw.purl);
    }
    if (raw.cpe && typeof raw.cpe === "string") {
        options.cpe = raw.cpe;
    }

    const component = new Models.Component(type, name, options);

    const scope = typeof raw.scope === "string" ? raw.scope : undefined;

    const hashes: ParsedHash[] = [];
    if (Array.isArray(raw.hashes)) {
        for (const hash of raw.hashes) {
            if (typeof hash === "object" && hash !== null) {
                const h = hash as Record<string, unknown>;
                if (typeof h.alg === "string" && typeof h.content === "string") {
                    hashes.push({ algorithm: h.alg, value: h.content });
                }
            }
        }
    }

    const externalRefs: ParsedExternalRef[] = [];
    if (Array.isArray(raw.externalReferences)) {
        for (const ref of raw.externalReferences) {
            if (typeof ref === "object" && ref !== null) {
                const r = ref as Record<string, unknown>;
                if (typeof r.type === "string" && typeof r.url === "string") {
                    externalRefs.push({
                        type: r.type,
                        url: r.url,
                        comment: typeof r.comment === "string" ? r.comment : undefined,
                    });
                }
            }
        }
    }

    if (Array.isArray(raw.licenses)) {
        for (const lic of raw.licenses) {
            if (typeof lic === "object" && lic !== null) {
                const license = parseLicense(lic as Record<string, unknown>);
                if (license) {
                    component.licenses.add(license);
                }
            }
        }
    }

    if (Array.isArray(raw.properties)) {
        for (const prop of raw.properties) {
            if (typeof prop === "object" && prop !== null) {
                const p = prop as Record<string, unknown>;
                if (typeof p.name === "string" && typeof p.value === "string") {
                    component.properties.add(new Models.Property(p.name, p.value));
                }
            }
        }
    }

    if (Array.isArray(raw.components)) {
        for (const nested of raw.components) {
            if (typeof nested === "object" && nested !== null) {
                const nestedData = parseComponent(nested as Record<string, unknown>);
                component.components.add(nestedData.component);
            }
        }
    }

    return { component, scope, hashes, externalRefs };
}

function parseLicense(raw: Record<string, unknown>): Models.License | undefined {
    if (typeof raw.expression === "string") {
        return new Models.LicenseExpression(raw.expression);
    }

    if (raw.license && typeof raw.license === "object") {
        const lic = raw.license as Record<string, unknown>;
        if (typeof lic.id === "string") {
            return new Models.SpdxLicense(lic.id);
        }
        if (typeof lic.name === "string") {
            return new Models.NamedLicense(lic.name);
        }
    }

    return undefined;
}

function parseCycloneDxJson(data: unknown): Models.Bom {
    if (typeof data !== "object" || data === null) {
        throw new Error("Invalid CycloneDX: must be an object");
    }

    const raw = data as Record<string, unknown>;

    if (raw.bomFormat !== "CycloneDX") {
        throw new Error("Invalid CycloneDX: bomFormat must be 'CycloneDX'");
    }

    if (typeof raw.specVersion !== "string") {
        throw new Error("Invalid CycloneDX: specVersion is required");
    }

    const bomOptions: Models.OptionalBomProperties = {};

    if (typeof raw.version === "number" && raw.version > 0) {
        bomOptions.version = raw.version;
    }

    if (typeof raw.serialNumber === "string") {
        bomOptions.serialNumber = raw.serialNumber;
    }

    const bom = new Models.Bom(bomOptions);

    if (raw.metadata && typeof raw.metadata === "object") {
        const meta = raw.metadata as Record<string, unknown>;

        if (typeof meta.timestamp === "string") {
            bom.metadata.timestamp = new Date(meta.timestamp);
        }

        if (meta.component && typeof meta.component === "object") {
            bom.metadata.component = parseComponent(meta.component as Record<string, unknown>).component;
        }

        if (meta.tools && typeof meta.tools === "object") {
            const tools = meta.tools as Record<string, unknown>;
            if (Array.isArray(tools.components)) {
                for (const toolComp of tools.components) {
                    if (typeof toolComp === "object" && toolComp !== null) {
                        bom.metadata.tools.components.add(
                            parseComponent(toolComp as Record<string, unknown>).component
                        );
                    }
                }
            }
        }
    }

    if (Array.isArray(raw.components)) {
        for (const comp of raw.components) {
            if (typeof comp === "object" && comp !== null) {
                bom.components.add(parseComponent(comp as Record<string, unknown>).component);
            }
        }
    }

    return bom;
}

function createSerializer(specVersion: Spec.Version = DEFAULT_SPEC_VERSION): Serialize.JsonSerializer {
    const spec = Spec.SpecVersionDict[specVersion];
    if (!spec) {
        throw new Error(`Unsupported spec version: ${specVersion}`);
    }
    return new Serialize.JsonSerializer(new Serialize.JSON.Normalize.Factory(spec));
}

/**
 * Extracts bom-refs that are transitive dependencies.
 * A component is transitive if it appears in any `dependsOn` array.
 */
function extractTransitiveDependencies(raw: Record<string, unknown>): Set<string> {
    const transitive = new Set<string>();
    
    if (!Array.isArray(raw.dependencies)) {
        return transitive;
    }

    for (const dep of raw.dependencies) {
        if (typeof dep === "object" && dep !== null) {
            const depObj = dep as Record<string, unknown>;
            if (Array.isArray(depObj.dependsOn)) {
                for (const ref of depObj.dependsOn) {
                    if (typeof ref === "string") {
                        transitive.add(ref);
                    }
                }
            }
        }
    }

    return transitive;
}

/**
 * Ingestion budget for one document (security review S9). The 10 MB body cap
 * alone still admits ~100k components — roughly half a million rows per
 * upload, repeatable with `?replace=true` — and unbounded nesting turned
 * into a `RangeError` in the recursive parser. Both caps are enforced by an
 * iterative walk over the raw JSON *before* any parsing or DB work.
 */
export const MAX_SBOM_COMPONENTS = 50_000;
export const MAX_SBOM_COMPONENT_DEPTH = 32;

/**
 * Reject documents over the component-count or nesting-depth budget.
 * Iterative on purpose: this guard must survive input that would blow the
 * stack of the recursive code paths it protects (`parseComponent`,
 * `parseCycloneDxJson`).
 */
export function assertComponentBudget(raw: Record<string, unknown>): void {
    if (!Array.isArray(raw.components)) return;

    let count = 0;
    const stack: Array<{ node: unknown; depth: number }> = [];
    for (const node of raw.components) stack.push({ node, depth: 1 });

    while (stack.length > 0) {
        const { node, depth } = stack.pop()!;
        if (typeof node !== "object" || node === null) continue;

        count += 1;
        if (count > MAX_SBOM_COMPONENTS) {
            throw new AppError(
                413,
                `SBOM has more than ${MAX_SBOM_COMPONENTS} components (including nested); refusing to ingest it`
            );
        }
        if (depth > MAX_SBOM_COMPONENT_DEPTH) {
            throw new AppError(
                400,
                `SBOM component nesting exceeds ${MAX_SBOM_COMPONENT_DEPTH} levels`
            );
        }

        const nested = (node as Record<string, unknown>).components;
        if (Array.isArray(nested)) {
            for (const child of nested) stack.push({ node: child, depth: depth + 1 });
        }
    }
}

/**
 * Flattens a component tree into a list, including nested components.
 * Iterative (explicit stack) so document shape can never decide our stack
 * depth — `assertComponentBudget` already capped it, this makes the cap
 * unnecessary rather than load-bearing.
 */
function flattenParsedComponents(
    raw: Record<string, unknown>,
    transitiveDeps: Set<string>
): Array<{ extended: ExtendedComponentData; isDirect: boolean }> {
    const result: Array<{ extended: ExtendedComponentData; isDirect: boolean }> = [];

    if (!Array.isArray(raw.components)) return result;

    for (const rawComp of raw.components) {
        if (typeof rawComp !== "object" || rawComp === null) continue;
        const extendedData = parseComponent(rawComp as Record<string, unknown>);
        const bomRef = extendedData.component.bomRef?.toString() ?? "";
        const isDirect = !transitiveDeps.has(bomRef);

        // Pre-order walk of this root's subtree, children in document order.
        const stack: Array<{ extended: ExtendedComponentData; isDirect: boolean }> = [
            { extended: extendedData, isDirect },
        ];
        while (stack.length > 0) {
            const item = stack.pop()!;
            result.push(item);
            const children = [...item.extended.component.components];
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({
                    extended: { component: children[i]!, hashes: [], externalRefs: [] },
                    isDirect: false,
                });
            }
        }
    }

    return result;
}

function extractSbomMetadata(raw: Record<string, unknown>) {
    const metadata = raw.metadata as Record<string, unknown> | undefined;
    
    let toolName: string | undefined;
    let toolVersion: string | undefined;
    let generatedAt: Date | undefined;
    let sourceName: string | undefined;
    let sourceType: string | undefined;

    if (metadata) {
        if (typeof metadata.timestamp === "string") {
            generatedAt = new Date(metadata.timestamp);
        }

        if (metadata.tools && typeof metadata.tools === "object") {
            const tools = metadata.tools as Record<string, unknown>;
            if (Array.isArray(tools.components) && tools.components.length > 0) {
                const firstTool = tools.components[0] as Record<string, unknown>;
                toolName = typeof firstTool.name === "string" ? firstTool.name : undefined;
                toolVersion = typeof firstTool.version === "string" ? firstTool.version : undefined;
            }
        }

        if (metadata.component && typeof metadata.component === "object") {
            const comp = metadata.component as Record<string, unknown>;
            sourceName = typeof comp.name === "string" ? comp.name : undefined;
            sourceType = typeof comp.type === "string" ? comp.type : undefined;
        }
    }

    return { toolName, toolVersion, generatedAt, sourceName, sourceType };
}

export interface StoredSbom {
    sbom: Sbom;
    bom: Models.Bom;
    components: Component[];
}

type LicenseEntry = { componentId: string; spdxId?: string; name?: string; expression?: string };

/** `syft:location:0:path` — what a `path-prefix` tier rule is compared with. */
function locationOf(properties: Iterable<{ name: string; value: string }>): string | null {
    for (const p of properties) if (p.name === "syft:location:0:path") return p.value;
    return null;
}

/** Project the flattened, parsed components into `components` insert rows. */
function buildComponentRows(
    sbomId: string,
    flatParsed: Array<{ extended: ExtendedComponentData; isDirect: boolean }>,
    layerByDiffId: ReadonlyMap<string, number>,
    tierRules: readonly TierRule[],
    imageFacts: Readonly<Record<string, string>> = {}
): NewComponent[] {
    const builtin = flatParsed.map(({ extended }) => classifyFromProperties({ name: extended.component.name }, extended.component.properties));
    // The image's own ENTRYPOINT / CMD says which executable it exists to run
    // (scanner ≥ 0.4.0). Where it answers, `main` is that one component.
    const narrowed = narrowMain(
        builtin,
        detectMainComponent(
            imageFacts,
            flatParsed.map(({ extended }, i) => mainCandidateOf(String(i), extended.component.name, extended.component.properties))
        )
    );
    return flatParsed.map(({ extended, isDirect }, i) => {
        const mc = extended.component;
        return {
            sbomId,
            purl: mc.purl?.toString() ?? null,
            name: mc.name,
            version: mc.version ?? null,
            type: mc.type,
            groupName: mc.group ?? null,
            publisher: mc.publisher ?? null,
            author: mc.author ?? null,
            description: mc.description ?? null,
            cpe: mc.cpe ?? null,
            bomRef: mc.bomRef?.toString() ?? null,
            isDirect,
            scope: (extended.scope as ComponentScope) ?? null,
            // Built-in rules, then the org's own (`component_tier_rules`).
            tier: applyTierRules(
                narrowed[i]!,
                { name: mc.name, purl: mc.purl?.toString() ?? null, path: locationOf(mc.properties) },
                tierRules
            ),
            tierVersion: TIER_VERSION,
            layerIndex: resolveLayerIndex(mc.properties, layerByDiffId),
        };
    });
}

/**
 * Walk the parsed components beside their inserted rows (same order, by
 * construction) and collect every satellite row to insert: hashes, external
 * refs, properties and license references.
 */
function collectComponentDetails(
    flatParsed: Array<{ extended: ExtendedComponentData; isDirect: boolean }>,
    allComponents: Component[]
): {
    allHashes: NewComponentHash[];
    allExternalRefs: NewComponentExternalRef[];
    allProperties: NewComponentProperty[];
    licenseData: LicenseEntry[];
} {
    const allHashes: NewComponentHash[] = [];
    const allExternalRefs: NewComponentExternalRef[] = [];
    const allProperties: NewComponentProperty[] = [];
    const licenseData: LicenseEntry[] = [];

    for (let i = 0; i < flatParsed.length; i++) {
        const { extended } = flatParsed[i]!;
        const component = allComponents[i]!;

        for (const h of extended.hashes) {
            allHashes.push({
                componentId: component.id,
                algorithm: h.algorithm as NewComponentHash["algorithm"],
                value: h.value,
            });
        }

        for (const r of extended.externalRefs) {
            allExternalRefs.push({
                componentId: component.id,
                type: r.type as NewComponentExternalRef["type"],
                url: r.url,
                comment: r.comment ?? null,
            });
        }

        for (const prop of extended.component.properties) {
            allProperties.push({
                componentId: component.id,
                name: prop.name,
                value: prop.value,
            });
        }

        for (const license of extended.component.licenses) {
            if (license instanceof Models.SpdxLicense) {
                licenseData.push({ componentId: component.id, spdxId: license.id });
            } else if (license instanceof Models.NamedLicense) {
                licenseData.push({ componentId: component.id, name: license.name });
            } else if (license instanceof Models.LicenseExpression) {
                licenseData.push({ componentId: component.id, expression: license.expression });
            }
        }
    }

    return { allHashes, allExternalRefs, allProperties, licenseData };
}

/** Deduplicate the referenced licenses into `licenses` rows and pair each
 *  component with the row it ended up referencing. */
async function resolveLicenseLinks(
    licenseData: LicenseEntry[],
    tx: Transaction
): Promise<Array<{ componentId: string; licenseId: string }>> {
    const licensesToResolve: NewLicense[] = licenseData.map(l => ({
        spdxId: l.spdxId ?? null,
        name: l.name ?? null,
        expression: l.expression ?? null,
    }));
    const licenseMap = await componentRepository.batchFindOrCreateLicenses(licensesToResolve, tx);
    const licenseLinks: Array<{ componentId: string; licenseId: string }> = [];
    for (const entry of licenseData) {
        const key = entry.spdxId ?? entry.expression ?? entry.name ?? "";
        const license = licenseMap.get(key);
        if (license) {
            licenseLinks.push({ componentId: entry.componentId, licenseId: license.id });
        }
    }
    return licenseLinks;
}

export const sbomService = {
    /**
     * List SBOMs for a single organisation. Mirrors the tenant isolation
     * contract of `GET /api/sboms`.
     */
    async findAllByOrg(orgId: string): Promise<Sbom[]> {
        return sbomRepository.findAllByOrg(orgId);
    },

    async findById(id: string): Promise<StoredSbom | undefined> {
        const sbom = await sbomRepository.findByIdWithComponents(id);
        if (!sbom) {
            return undefined;
        }

        const bom = this.reconstructBom(sbom);
        return { sbom, bom, components: sbom.components };
    },

    reconstructBom(sbom: Sbom): Models.Bom {
        if (sbom.rawJson) {
            return parseCycloneDxJson(sbom.rawJson);
        }

        const bom = new Models.Bom({
            serialNumber: sbom.serialNumber ?? undefined,
            version: sbom.documentVersion ?? 1,
        });

        if (sbom.generatedAt) {
            bom.metadata.timestamp = sbom.generatedAt;
        }

        return bom;
    },

    /**
     * Parses and stores a CycloneDX JSON object for one **image**.
     *
     * Each SBOM gets its own set of component rows -- no cross-SBOM
     * deduplication. What *is* deduplicated is the SBOM itself: one row per
     * image digest, enforced by `sboms_image_id_unique`, so the same image in
     * five namespaces is parsed once instead of five times.
     */
    async createFromCycloneDx(
        data: unknown,
        imageId: string,
        options: {
            /**
             * Supersede an existing SBOM for the image instead of throwing
             * `DuplicateSbomError`. Safe under ADR 0006: the image — and so
             * the replacement's whole blast radius — belongs to one cluster.
             */
            replace?: boolean | undefined;
            /** `X-Scanner-Version` of the uploader, stored as provenance. */
            scannerVersion?: string | undefined;
        } = {}
    ): Promise<StoredSbom> {
        assertCycloneDx(data);
        assertComponentBudget(data);
        const sbomSha256 = computeSbomHash(data);
        const { replace, scannerVersion } = options;

        const existing = await sbomRepository.findByImageId(imageId);
        if (existing && !replace) {
            throw new DuplicateSbomError(existing.id, existing.sbomSha256);
        }

        const bom = parseCycloneDxJson(data);
        const raw = data as Record<string, unknown>;
        const { toolName, toolVersion, generatedAt, sourceName, sourceType } = extractSbomMetadata(raw);
        const transitiveDeps = extractTransitiveDependencies(raw);

        // Phase 1: Parse all components (CPU only, no DB)
        const flatParsed = flattenParsedComponents(raw, transitiveDeps);
        // The image's layers and facts, when the scanner sent them (≥ 0.4.0).
        // An upload without them is not an error — see `lib/image-layers.ts`.
        const imageMetadata = parseImageMetadata(raw);
        // The org's classifier overrides, read once per upload. Usually none.
        const [owner] = await db.select({ orgId: schema.images.orgId }).from(schema.images).where(eq(schema.images.id, imageId));
        const tierRules = owner ? await tierRulesForOrg(owner.orgId) : [];

        // Phase 2-5: All DB writes in a single transaction.
        //
        // Two concurrent uploads from one cluster can reach the same fresh
        // digest at the same moment -- the case the scanner's `check` call is
        // meant to avoid and cannot always win. `sboms_image_id_unique`
        // decides it at the database, and the loser reports the winner's row as
        // a duplicate rather than writing a second copy. (Across clusters
        // there is no race left to decide: each cluster has its own image row.)
        const runTransaction = async (): Promise<StoredSbom> => db.transaction(async (tx) => {
            /*
             * Supersede: drop the old SBOM's subtree in the same transaction
             * that inserts the new one, so the image never observably has zero
             * or two SBOMs. Re-read inside the transaction rather than trusting
             * the pre-check — the earlier lookup ran outside it.
             */
            const replaced = replace ? await sbomRepository.findByImageId(imageId) : undefined;
            if (replaced) {
                await deleteSbomSubtreeInTx(tx, replaced.id);
            }

            const sbom = await sbomRepository.create({
                imageId,
                format: "cyclonedx" satisfies SbomFormat,
                sbomSha256,
                scannerVersion: scannerVersion ?? null,
                serialNumber: bom.serialNumber ?? null,
                documentVersion: bom.version > 0 ? bom.version : null,
                specVersion: String(raw.specVersion),
                sourceName: sourceName ?? null,
                sourceType: sourceType ?? null,
                generatedAt: generatedAt ?? null,
                toolName: toolName ?? null,
                toolVersion: toolVersion ?? null,
                rawJson: raw,
            }, tx);

            /*
             * Layers belong to the image, not to this SBOM (ADR 0004): an
             * upload that carries them replaces the image's rows, one that
             * does not leaves whatever is there — the registry backfill may
             * have filled them — and still resolves its components against it.
             */
            const layers = imageMetadata.layers.length > 0
                ? await imageLayerRepository.replaceForImage(imageId, imageMetadata.layers, "scanner", tx)
                : await imageLayerRepository.findByImageId(imageId, tx);
            if (Object.keys(imageMetadata.facts).length > 0) {
                await imageLayerRepository.setImageMetadata(imageId, imageMetadata.facts, tx);
            }

            const allComponents = await componentRepository.batchCreate(
                buildComponentRows(sbom.id, flatParsed, layerIndexByDiffId(layers), tierRules, imageMetadata.facts),
                tx
            );

            const bomRefToComponentId = new Map<string, string>();
            for (const comp of allComponents) {
                if (comp.bomRef) {
                    bomRefToComponentId.set(comp.bomRef, comp.id);
                }
            }

            const { allHashes, allExternalRefs, allProperties, licenseData } =
                collectComponentDetails(flatParsed, allComponents);
            const licenseLinks = await resolveLicenseLinks(licenseData, tx);

            await Promise.all([
                componentRepository.batchAddAllHashes(allHashes, tx),
                componentRepository.batchAddAllExternalRefs(allExternalRefs, tx),
                componentRepository.batchAddComponentProperties(allProperties, tx),
                componentRepository.batchLinkComponentLicenses(licenseLinks, tx),
                this.storeDependencies(sbom.id, raw, bomRefToComponentId, tx),
            ]);

            return {
                sbom,
                bom,
                components: allComponents,
            };
        });

        try {
            const stored = await runTransaction();
            // Where the base image ends, and `from_base` on the components
            // just written. After the commit and best-effort: it reads the
            // org's other images and the known-prefix table, and a label must
            // never be the reason an upload fails. The nightly pass retries.
            await resolveBaseForImage(imageId).catch((error: unknown) => {
                log.warn({ error, imageId }, "Could not resolve the base image boundary");
            });
            return stored;
        } catch (err) {
            if (isUniqueViolationOn(err, "sboms_image_id_unique")) {
                // Another upload stored this image's SBOM between our
                // `findByImageId` check and this INSERT. That is a duplicate,
                // not a failure: the digest is scanned either way, so report
                // the winner's row rather than retrying into the same wall.
                const winner = await sbomRepository.findByImageId(imageId);
                if (winner) throw new DuplicateSbomError(winner.id, winner.sbomSha256);
            }
            throw err;
        }
    },

    /**
     * Stores component dependencies from the CycloneDX dependencies array
     */
    async storeDependencies(
        sbomId: string,
        raw: Record<string, unknown>,
        bomRefToComponentId: Map<string, string>,
        tx?: Transaction
    ): Promise<void> {
        if (!Array.isArray(raw.dependencies)) {
            return;
        }

        const dependenciesToInsert: Array<{
            sbomId: string;
            parentComponentId: string;
            childComponentId: string;
        }> = [];

        for (const dep of raw.dependencies) {
            if (typeof dep !== "object" || dep === null) continue;
            
            const depObj = dep as Record<string, unknown>;
            const parentRef = depObj.ref;
            
            if (typeof parentRef !== "string") continue;
            if (!Array.isArray(depObj.dependsOn)) continue;

            const parentComponentId = bomRefToComponentId.get(parentRef);
            if (!parentComponentId) continue;

            for (const childRef of depObj.dependsOn) {
                if (typeof childRef !== "string") continue;
                
                const childComponentId = bomRefToComponentId.get(childRef);
                if (!childComponentId) continue;

                dependenciesToInsert.push({
                    sbomId,
                    parentComponentId,
                    childComponentId,
                });
            }
        }

        await sbomRepository.addDependencies(dependenciesToInsert, tx);
    },

    async validate(
        jsonString: string,
        specVersion: Spec.Version = DEFAULT_SPEC_VERSION
    ): Promise<Validation.Types.ValidationError | null> {
        const validator = new Validation.JsonValidator(specVersion);
        return validator.validate(jsonString);
    },

    export(stored: StoredSbom, specVersion: Spec.Version = DEFAULT_SPEC_VERSION): string {
        const serializer = createSerializer(specVersion);
        return serializer.serialize(stored.bom, { sortLists: true });
    },

    toResponse(stored: StoredSbom, specVersion: Spec.Version = DEFAULT_SPEC_VERSION): SbomResponse {
        const serializer = createSerializer(specVersion);
        const bomJson = JSON.parse(serializer.serialize(stored.bom, { sortLists: true }));

        return {
            id: stored.sbom.id,
            format: stored.sbom.format as SbomFormat,
            bom: bomJson,
            createdAt: stored.sbom.createdAt,
        };
    },

    toListResponse(sbom: Sbom): SbomListResponse {
        return {
            id: sbom.id,
            format: sbom.format as SbomFormat,
            specVersion: sbom.specVersion,
            imageId: sbom.imageId,
            sourceName: sbom.sourceName,
            sourceType: sbom.sourceType,
            toolName: sbom.toolName,
            generatedAt: sbom.generatedAt,
            createdAt: sbom.createdAt,
        };
    },

    toUploadResponse(stored: StoredSbom): SbomUploadResponse {
        return {
            id: stored.sbom.id,
            format: stored.sbom.format as SbomFormat,
            specVersion: stored.sbom.specVersion,
            imageId: stored.sbom.imageId,
            componentCount: stored.components.length,
            sourceName: stored.sbom.sourceName,
            toolName: stored.sbom.toolName,
            createdAt: stored.sbom.createdAt,
        };
    },

    async delete(id: string): Promise<boolean> {
        return sbomRepository.delete(id);
    },
};

export interface SbomResponse {
    id: string;
    format: SbomFormat;
    bom: Record<string, unknown>;
    createdAt: Date;
}

export interface SbomListResponse {
    id: string;
    format: SbomFormat;
    specVersion: string;
    imageId: string;
    sourceName: string | null;
    sourceType: string | null;
    toolName: string | null;
    generatedAt: Date | null;
    createdAt: Date;
}

export interface SbomUploadResponse {
    id: string;
    format: SbomFormat;
    specVersion: string;
    imageId: string;
    componentCount: number;
    sourceName: string | null;
    toolName: string | null;
    createdAt: Date;
}

export class DuplicateSbomError extends Error {
    constructor(
        public readonly existingId: string,
        public readonly hash: string
    ) {
        super(`This image already has an SBOM (id: ${existingId}, hash: ${hash})`);
        this.name = "DuplicateSbomError";
    }
}
