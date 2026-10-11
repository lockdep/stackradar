import { eq, and, desc, gte, getTableColumns, sql, count, exists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema, type Transaction } from "../db/index.js";
import type { Sbom, NewSbom } from "../db/schema/sboms.js";
import type { Component } from "../db/schema/components.js";
import type { NewComponentDependency, ComponentDependency } from "../db/schema/component-dependencies.js";
import { deleteSbomSubtree } from "./delete-helpers.js";

export interface SbomWithComponents extends Sbom {
    components: Component[];
}

export const sbomRepository = {
    /**
     * ADMIN / WORKER USE ONLY — returns every SBOM across every org.
     * Never call from an HTTP handler without an explicit `orgId` filter.
     * See `findAllByOrg` for the tenant-scoped variant.
     */
    async findAll(): Promise<Sbom[]> {
        return db.select().from(schema.sboms);
    },

    /**
     * Tenant-scoped list — every SBOM on an image the org owns.
     *
     * Ownership is `images.org_id` now (ADR 0006), so an
     * uploaded-but-not-yet-inventoried image's SBOM is visible to the org
     * whose cluster uploaded it. Never windowed by plan: this is the current
     * inventory, not history (see `config/plans.ts`).
     */
    async findAllByOrg(orgId: string): Promise<Sbom[]> {
        const ownedHere = exists(
            db
                .select({ one: sql`1` })
                .from(schema.images)
                .where(and(eq(schema.images.id, schema.sboms.imageId), eq(schema.images.orgId, orgId))),
        );
        return db.select().from(schema.sboms).where(ownedHere).orderBy(desc(schema.sboms.createdAt));
    },

    /** Total SBOMs stored for images the org owns. One SBOM is one image. */
    async countByOrg(orgId: string): Promise<number> {
        const [result] = await db
            .select({ count: count() })
            .from(schema.sboms)
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .where(eq(schema.images.orgId, orgId));
        return result?.count ?? 0;
    },

    /**
     * SBOMs ingested since the start of the current calendar month for an org.
     * Used to enforce the uniqueImagesPerMonth plan limit. Note the ADR 0006
     * meaning shift: one digest deployed to three clusters is three images and
     * three uploads.
     */
    async countThisMonthByOrg(orgId: string): Promise<number> {
        const startOfMonth = new Date();
        startOfMonth.setUTCDate(1);
        startOfMonth.setUTCHours(0, 0, 0, 0);
        const [result] = await db
            .select({ count: count() })
            .from(schema.sboms)
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .where(and(eq(schema.images.orgId, orgId), gte(schema.sboms.createdAt, startOfMonth)));
        return result?.count ?? 0;
    },

    async findById(id: string): Promise<Sbom | undefined> {
        const results = await db.select().from(schema.sboms).where(eq(schema.sboms.id, id));
        return results[0];
    },

    async findByIdWithComponents(id: string): Promise<SbomWithComponents | undefined> {
        const sbom = await this.findById(id);
        if (!sbom) {
            return undefined;
        }

        const components = await db.select().from(schema.components).where(eq(schema.components.sbomId, id));

        return { ...sbom, components };
    },

    /**
     * The image's SBOM. Singular by construction — `sboms_image_id_unique`
     * enforces one row per image, which is what replaced `isCurrent`.
     */
    async findByImageId(imageId: string): Promise<Sbom | undefined> {
        const results = await db.select().from(schema.sboms).where(eq(schema.sboms.imageId, imageId));
        return results[0];
    },

    async create(data: NewSbom, tx?: Transaction): Promise<Sbom> {
        const [result] = await (tx ?? db).insert(schema.sboms).values(data).returning();
        return result!;
    },

    /**
     * Delete an SBOM along with every row that belongs to it. Uses set-based deletes
     * against indexed columns instead of per-row FK cascade. See
     * {@link deleteSbomSubtree} for details.
     */
    async delete(id: string): Promise<boolean> {
        return deleteSbomSubtree(id);
    },

    // Component dependency operations
    async addDependencies(data: NewComponentDependency[], tx?: Transaction): Promise<void> {
        if (data.length === 0) return;
        await (tx ?? db).insert(schema.componentDependencies).values(data).onConflictDoNothing();
    },

    /**
     * Get all dependencies for an SBOM, filtered to only include library components.
     */
    async getAllDependenciesBySbomId(sbomId: string): Promise<ComponentDependency[]> {
        const parentComponent = alias(schema.components, "parent_component");
        const childComponent = alias(schema.components, "child_component");

        const results = await db
            .select({
                sbomId: schema.componentDependencies.sbomId,
                parentComponentId: schema.componentDependencies.parentComponentId,
                childComponentId: schema.componentDependencies.childComponentId,
                createdAt: schema.componentDependencies.createdAt,
            })
            .from(schema.componentDependencies)
            .innerJoin(
                parentComponent,
                and(
                    eq(schema.componentDependencies.parentComponentId, parentComponent.id),
                    eq(parentComponent.type, "library"),
                ),
            )
            .innerJoin(
                childComponent,
                and(
                    eq(schema.componentDependencies.childComponentId, childComponent.id),
                    eq(childComponent.type, "library"),
                ),
            )
            .where(eq(schema.componentDependencies.sbomId, sbomId));

        return results;
    },

    /** The image's SBOM with a component count, for the detail header. */
    async findByImageIdWithComponentCount(
        imageId: string,
    ): Promise<(Omit<Sbom, "rawJson"> & { componentCount: number }) | undefined> {
        const { rawJson, ...sbomCols } = getTableColumns(schema.sboms);
        const rows = await db
            .select({
                ...sbomCols,
                componentCount: sql<number>`cast(count(${schema.components.id}) as int)`,
            })
            .from(schema.sboms)
            .leftJoin(schema.components, eq(schema.components.sbomId, schema.sboms.id))
            .where(eq(schema.sboms.imageId, imageId))
            .groupBy(schema.sboms.id);
        return rows[0];
    },

    /**
     * Has **this cluster** scanned this digest.
     *
     * Scoped, deliberately (ADR 0006): the global form of this answer was an
     * oracle over every tenant's scanning activity, and it was what let one
     * tenant's upload stop every other tenant from ever scanning a digest.
     * Still no namespace and no container name — one image in five namespaces
     * of one cluster is one pull, one syft run, one matching pass.
     *
     * The scanner calls this before every pull, so it runs on the hot path and
     * is served by `images_cluster_digest_unique` plus the `sboms.image_id`
     * unique index — two index lookups, no scan.
     */
    async existsByDigest(clusterId: string, imageDigest: string): Promise<boolean> {
        const results = await db
            .select({ id: schema.sboms.id })
            .from(schema.sboms)
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .where(and(eq(schema.images.clusterId, clusterId), eq(schema.images.digest, imageDigest)))
            .limit(1);
        return results.length > 0;
    },
};
