import { asc, eq } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import type { ImageLayer } from "../db/schema/image-layers.js";
import type { ParsedLayer } from "../lib/image-layers.js";

/** Bulk insert size: 9 columns × 500 rows stays far under the 65,535-parameter limit. */
const CHUNK = 500;

export const imageLayerRepository = {
    async findByImageId(imageId: string, tx?: Transaction): Promise<ImageLayer[]> {
        return (tx ?? db)
            .select()
            .from(schema.imageLayers)
            .where(eq(schema.imageLayers.imageId, imageId))
            .orderBy(asc(schema.imageLayers.index));
    },

    /**
     * Make the image's layer rows equal `layers`. A digest's layers cannot
     * change, so "replace" is about *which writer knew more*: a scanner upload
     * supersedes the registry backfill's rows (it has sizes and the redacted
     * lines as the customer's cluster saw them), never the reverse — the
     * backfill only ever calls this for an image with no rows.
     */
    async replaceForImage(
        imageId: string,
        layers: readonly ParsedLayer[],
        source: "scanner" | "registry",
        tx?: Transaction,
    ): Promise<ImageLayer[]> {
        const run = async (q: Transaction): Promise<ImageLayer[]> => {
            await q.delete(schema.imageLayers).where(eq(schema.imageLayers.imageId, imageId));
            const rows: ImageLayer[] = [];
            for (let i = 0; i < layers.length; i += CHUNK) {
                const inserted = await q
                    .insert(schema.imageLayers)
                    .values(
                        layers.slice(i, i + CHUNK).map((l) => ({
                            imageId,
                            index: l.index,
                            rootfsIndex: l.rootfsIndex,
                            diffId: l.diffId,
                            createdBy: l.createdBy,
                            emptyLayer: l.emptyLayer,
                            size: l.size,
                            builtAt: l.created,
                            source,
                        })),
                    )
                    .returning();
                rows.push(...inserted);
            }
            return rows;
        };
        return tx ? run(tx) : db.transaction(run);
    },

    /** The `stackradar:image:*` facts of the latest upload that carried any. */
    async setImageMetadata(imageId: string, facts: Record<string, string>, tx?: Transaction): Promise<void> {
        await (tx ?? db)
            .update(schema.images)
            .set({ metadata: facts, updatedAt: new Date() })
            .where(eq(schema.images.id, imageId));
    },
};
