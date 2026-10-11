/**
 * Loads what `lib/image-control.ts` reads, resolves, and writes
 * `images.control` for the rows whose verdict changed.
 *
 * Set-based per org: one query each for the rules, the images, the public
 * charts delivering them, and those charts' rendered image sets — never a
 * query per image. It is called where a verdict can change:
 *
 *   - after an inventory report (a new repository, a new delivering release);
 *   - after an SBOM upload (the `official` fact arrives with the metadata);
 *   - after the nightly chart-attribution pass (a release gained a public chart);
 *   - after an org edits its rules;
 *   - by `scripts/backfill-image-control.ts`, for everything.
 *
 * All but the last two pass image ids or are nightly, so the cost on the
 * ingest path is four indexed reads over a handful of rows. Callers on a
 * request path use {@link resolveImageControlQuietly}: a label must never
 * fail an inventory report.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
    CONTROL_SIGNALS,
    matchingRule,
    resolveControl,
    type ControlRule,
    type ControlSignal,
    type ImageControl,
} from "../lib/image-control.js";
import { normalizeRegistry, pairRepository } from "../lib/public-registries.js";
import { prefixHashes } from "../lib/base-image.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("image-control");

const CHUNK = 1_000;

export interface ControlResolutionStats {
    images: number;
    changed: number;
    /** Images per deciding signal; `unknown` for the ones nothing decided. */
    histogram: Record<string, number>;
}

type DeliveringChart = { chartName: string; repositories: Set<string> };

const chartKey = (repoUrl: string, chartName: string) => JSON.stringify([repoUrl, chartName]);

async function deliveringChartsByImage(
    orgId: string,
    imageIds: string[] | undefined,
): Promise<Map<string, DeliveringChart[]>> {
    // A release's chart, attributed to a public (Artifact Hub) chart for this org.
    const rows = await db
        .selectDistinct({
            imageId: schema.workloadContainers.imageId,
            chartName: schema.chartAttributions.chartName,
            repoUrl: schema.chartAttributions.repoUrl,
        })
        .from(schema.workloadContainers)
        .innerJoin(schema.workloads, eq(schema.workloads.id, schema.workloadContainers.workloadId))
        .innerJoin(schema.helmReleases, eq(schema.helmReleases.id, schema.workloads.releaseId))
        .innerJoin(
            schema.chartAttributions,
            and(
                eq(schema.chartAttributions.orgId, schema.workloadContainers.orgId),
                eq(schema.chartAttributions.chartName, schema.helmReleases.chartName),
            ),
        )
        .where(
            and(
                eq(schema.workloadContainers.orgId, orgId),
                imageIds ? inArray(schema.workloadContainers.imageId, imageIds) : undefined,
            ),
        );
    if (rows.length === 0) return new Map();

    // The image set of each such chart, over every version we have rendered:
    // which repositories a chart deploys changes far less than its tags do.
    const charts = new Map<string, { repoUrl: string; chartName: string }>();
    for (const r of rows) charts.set(chartKey(r.repoUrl, r.chartName), { repoUrl: r.repoUrl, chartName: r.chartName });

    const observed = new Map<string, Set<string>>();
    const chartList = [...charts.values()];
    for (let i = 0; i < chartList.length; i += CHUNK) {
        const pairs = chartList.slice(i, i + CHUNK).map((c) => sql`(${c.repoUrl}, ${c.chartName})`);
        const sets = await db
            .selectDistinct({
                repoUrl: schema.chartImageObservations.repoUrl,
                chartName: schema.chartImageObservations.chartName,
                registry: schema.chartImageObservations.registry,
                repository: schema.chartImageObservations.repository,
            })
            .from(schema.chartImageObservations)
            .where(
                sql`(${schema.chartImageObservations.repoUrl}, ${schema.chartImageObservations.chartName}) IN (${sql.join(pairs, sql`, `)})`,
            );
        for (const s of sets) {
            const key = chartKey(s.repoUrl, s.chartName);
            const set = observed.get(key) ?? new Set<string>();
            set.add(pairRepository(s.registry, s.repository));
            observed.set(key, set);
        }
    }

    const byImage = new Map<string, DeliveringChart[]>();
    for (const row of rows) {
        const repositories = observed.get(chartKey(row.repoUrl, row.chartName));
        // Attributed but never rendered: the image set is unknown, so the
        // signal stays silent rather than guessing from the release alone — a
        // generic public chart (app-template) routinely runs the org's own image.
        if (!repositories) continue;
        const list = byImage.get(row.imageId) ?? [];
        list.push({ chartName: row.chartName, repositories });
        byImage.set(row.imageId, list);
    }
    return byImage;
}

/**
 * Whether an image's layers *are* a known public image's, or start with
 * one — `known_layer_prefixes`, the same table base detection reads.
 */
async function layerMatchesFor(imageIds: string[]): Promise<Map<string, "known-image" | "built-on-known">> {
    const result = new Map<string, "known-image" | "built-on-known">();
    if (imageIds.length === 0) return result;

    const chains = await db
        .select({
            imageId: schema.imageLayers.imageId,
            diffIds: sql<string[]>`array_agg(${schema.imageLayers.diffId} ORDER BY ${schema.imageLayers.rootfsIndex})`,
        })
        .from(schema.imageLayers)
        .where(and(inArray(schema.imageLayers.imageId, imageIds), isNotNull(schema.imageLayers.diffId)))
        .groupBy(schema.imageLayers.imageId);
    if (chains.length === 0) return result;

    const hashesByImage = new Map(chains.map((c) => [c.imageId, prefixHashes(c.diffIds)]));
    const allHashes = [...new Set([...hashesByImage.values()].flat())];
    const known = new Map<string, number>();
    for (let i = 0; i < allHashes.length; i += CHUNK) {
        const rows = await db
            .selectDistinct({
                hash: schema.knownLayerPrefixes.diffIdPrefixHash,
                depth: schema.knownLayerPrefixes.depth,
            })
            .from(schema.knownLayerPrefixes)
            .where(inArray(schema.knownLayerPrefixes.diffIdPrefixHash, allHashes.slice(i, i + CHUNK)));
        for (const r of rows) known.set(r.hash, r.depth);
    }

    for (const [imageId, hashes] of hashesByImage) {
        // A hash only counts at the depth it was stored for.
        const whole = known.get(hashes[hashes.length - 1]!) === hashes.length;
        if (whole) {
            result.set(imageId, "known-image");
        } else if (hashes.some((h, i) => i < hashes.length - 1 && known.get(h) === i + 1)) {
            result.set(imageId, "built-on-known");
        }
    }
    return result;
}

/** Resolve and store `images.control` for an org's images, or for `imageIds` of them. */
export async function resolveImageControl(orgId: string, imageIds?: string[]): Promise<ControlResolutionStats> {
    const stats: ControlResolutionStats = { images: 0, changed: 0, histogram: {} };
    if (imageIds && imageIds.length === 0) return stats;

    const [ruleRows, images, charts] = await Promise.all([
        db.select().from(schema.imageControlRules).where(eq(schema.imageControlRules.orgId, orgId)),
        db
            .select({
                id: schema.images.id,
                registry: schema.images.registry,
                repository: schema.images.repository,
                metadata: schema.images.metadata,
                control: schema.images.control,
                controlDetectedBy: schema.images.controlDetectedBy,
                controlDetail: schema.images.controlDetail,
            })
            .from(schema.images)
            .where(and(eq(schema.images.orgId, orgId), imageIds ? inArray(schema.images.id, imageIds) : undefined)),
        deliveringChartsByImage(orgId, imageIds),
    ]);

    const rules: ControlRule[] = ruleRows.map((r) => ({
        registry: r.registry,
        repository: r.repository,
        control: r.control,
    }));

    const inputOf = (image: (typeof images)[number]) => ({
        registry: image.registry,
        repository: image.repository,
        rules,
        deliveringCharts: charts.get(image.id) ?? [],
        official: image.metadata?.official === "true",
    });

    // The layer comparison costs a chain and a lookup per image, so it is
    // made only where it can change the answer: the images no stronger
    // signal decided.
    const undecided = images.filter((image) => {
        const by = resolveControl(inputOf(image)).detectedBy;
        return by === null || by === "public-registry";
    });
    const layerMatches = await layerMatchesFor(undecided.map((i) => i.id));

    type Change = { control: ImageControl; detectedBy: ControlSignal | null; detail: string | null; ids: string[] };
    const changes = new Map<string, Change>();
    for (const image of images) {
        stats.images += 1;
        const verdict = resolveControl({ ...inputOf(image), layerMatch: layerMatches.get(image.id) ?? null });
        const bucket = verdict.detectedBy ?? "unknown";
        stats.histogram[bucket] = (stats.histogram[bucket] ?? 0) + 1;

        const detail = verdict.detail?.slice(0, 255) ?? null;
        if (
            verdict.control === image.control &&
            verdict.detectedBy === image.controlDetectedBy &&
            detail === image.controlDetail
        ) {
            continue;
        }

        const key = JSON.stringify([verdict.control, verdict.detectedBy, detail]);
        const group = changes.get(key) ?? { control: verdict.control, detectedBy: verdict.detectedBy, detail, ids: [] };
        group.ids.push(image.id);
        changes.set(key, group);
    }

    for (const group of changes.values()) {
        for (let i = 0; i < group.ids.length; i += CHUNK) {
            await db
                .update(schema.images)
                .set({ control: group.control, controlDetectedBy: group.detectedBy, controlDetail: group.detail })
                .where(inArray(schema.images.id, group.ids.slice(i, i + CHUNK)));
        }
        stats.changed += group.ids.length;
    }

    return stats;
}

/** {@link resolveImageControl}, for the call sites where a label must not fail the request. */
export async function resolveImageControlQuietly(orgId: string, imageIds?: string[]): Promise<void> {
    try {
        await resolveImageControl(orgId, imageIds);
    } catch (error) {
        log.warn({ error, orgId }, "Could not resolve image control; the previous verdicts stand");
    }
}

// ─── The org's view of it: one row per repository ─────────────────────────

export interface RepositoryControl {
    /** Normalised (`docker.io`), as rules are stored. */
    registry: string;
    repository: string;
    /** What is in force — the rule's answer when there is one. */
    control: ImageControl;
    /** What the derivation says with the org's rules set aside — the "Detected" column. */
    detected: { control: ImageControl; detectedBy: ControlSignal | null; detail: string | null };
    rule: {
        control: Exclude<ImageControl, "unknown">;
        reason: string | null;
        createdByEmail: string | null;
        updatedAt: Date;
    } | null;
    /**
     * `org.opencontainers.image.source` of one of its digests, when the
     * scanner sent it. Not a signal — we do not know which Git orgs a
     * customer owns — but it makes the human answer faster.
     */
    source: string | null;
    imageCount: number;
    containerCount: number;
}

/**
 * Every image repository the org runs, with what was detected and what the
 * org has said — the confirm-once prompt and the Image ownership tab. Running
 * images only: a repository nothing runs any more is not worth a question.
 */
export async function describeImageRepositories(orgId: string): Promise<RepositoryControl[]> {
    const [ruleRows, images, charts, containerCounts] = await Promise.all([
        db.select().from(schema.imageControlRules).where(eq(schema.imageControlRules.orgId, orgId)),
        db
            .select({
                id: schema.images.id,
                registry: schema.images.registry,
                repository: schema.images.repository,
                metadata: schema.images.metadata,
            })
            .from(schema.images)
            .where(eq(schema.images.orgId, orgId)),
        deliveringChartsByImage(orgId, undefined),
        db
            .select({ imageId: schema.workloadContainers.imageId, n: sql<number>`count(*)::int` })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.orgId, orgId))
            .groupBy(schema.workloadContainers.imageId),
    ]);

    const running = new Map(containerCounts.map((c) => [c.imageId, c.n]));
    const rules: ControlRule[] = ruleRows.map((r) => ({
        registry: r.registry,
        repository: r.repository,
        control: r.control,
    }));

    const SIGNAL_RANK = new Map<ControlSignal | null, number>(CONTROL_SIGNALS.map((s, i) => [s, i] as const));
    const rank = (s: ControlSignal | null) => SIGNAL_RANK.get(s) ?? CONTROL_SIGNALS.length;

    const byRepository = new Map<string, RepositoryControl>();
    for (const image of images) {
        const containers = running.get(image.id) ?? 0;
        if (!image.repository || containers === 0) continue;
        const registry = normalizeRegistry(image.registry);
        const key = JSON.stringify([registry, image.repository]);

        const detected = resolveControl({
            registry: image.registry,
            repository: image.repository,
            rules: [],
            deliveringCharts: charts.get(image.id) ?? [],
            official: image.metadata?.official === "true",
        });

        const row = byRepository.get(key);
        if (!row) {
            const rule = matchingRule(rules, image.registry, image.repository);
            const ruleRow = rule
                ? (ruleRows.find((r) => r.registry === rule.registry && r.repository === rule.repository) ?? null)
                : null;
            byRepository.set(key, {
                registry,
                repository: image.repository,
                control: rule?.control ?? detected.control,
                detected,
                rule: ruleRow
                    ? {
                          control: ruleRow.control,
                          reason: ruleRow.reason,
                          createdByEmail: ruleRow.createdByEmail,
                          updatedAt: ruleRow.updatedAt,
                      }
                    : null,
                source: image.metadata?.source ?? null,
                imageCount: 1,
                containerCount: containers,
            });
            continue;
        }
        row.imageCount += 1;
        row.containerCount += containers;
        row.source ??= image.metadata?.source ?? null;
        // Digests of one repository can disagree (one carries the official
        // annotation, one is delivered by a chart): the strongest signal speaks.
        if (rank(detected.detectedBy) < rank(row.detected.detectedBy)) {
            row.detected = detected;
            if (!row.rule) row.control = detected.control;
        }
    }

    return [...byRepository.values()].sort(
        (a, b) => a.registry.localeCompare(b.registry) || a.repository.localeCompare(b.repository),
    );
}

export interface ControlRuleChange {
    registry: string | null;
    repository: string;
    /** Null resets the repository to what was detected (the rule is deleted). */
    control: Exclude<ImageControl, "unknown"> | null;
    reason?: string | null | undefined;
}

/**
 * Apply an org's answers: upsert a rule per change, delete on `null`, write
 * one `image.control-set` event per row that actually changed, and re-resolve
 * the org. Returns how many rules changed.
 */
export async function applyControlRules(
    orgId: string,
    actor: { userId: string | null; email: string | null },
    changes: readonly ControlRuleChange[],
): Promise<number> {
    let changed = 0;
    await db.transaction(async (tx) => {
        const existing = await tx
            .select()
            .from(schema.imageControlRules)
            .where(eq(schema.imageControlRules.orgId, orgId));
        const find = (registry: string | null, repository: string) =>
            existing.find((r) => (r.registry ?? null) === registry && r.repository === repository);

        for (const change of changes) {
            const registry = normalizeRuleRegistry(change.registry);
            const current = find(registry, change.repository);

            if (change.control === null) {
                if (!current) continue;
                await tx.delete(schema.imageControlRules).where(eq(schema.imageControlRules.id, current.id));
            } else if (!current) {
                await tx.insert(schema.imageControlRules).values({
                    orgId,
                    registry,
                    repository: change.repository,
                    control: change.control,
                    reason: change.reason ?? null,
                    createdBy: actor.userId,
                    createdByEmail: actor.email,
                });
            } else if (
                current.control !== change.control ||
                (change.reason !== undefined && change.reason !== current.reason)
            ) {
                await tx
                    .update(schema.imageControlRules)
                    .set({
                        control: change.control,
                        reason: change.reason === undefined ? current.reason : change.reason,
                        createdBy: actor.userId,
                        createdByEmail: actor.email,
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.imageControlRules.id, current.id));
            } else {
                continue;
            }

            changed += 1;
            await tx.insert(schema.activityEvents).values({
                orgId,
                type: "image.control-set",
                payload: {
                    registry,
                    repository: change.repository,
                    control: change.control,
                    previous: current?.control ?? null,
                    reason: change.reason ?? null,
                    byUserId: actor.userId,
                    byEmail: actor.email,
                },
            });
        }
    });

    if (changed > 0) await resolveImageControl(orgId);
    return changed;
}

/**
 * The inventory path's call: only the cluster's images nothing has decided
 * yet — a new repository arrives `unknown`. One indexed read when there are
 * none, which after the confirm prompt is every report. An image that gains
 * a delivering chart later is picked up by the nightly attribution pass.
 */
export async function resolveUndecidedInCluster(orgId: string, clusterId: string): Promise<void> {
    try {
        const undecided = await db
            .select({ id: schema.images.id })
            .from(schema.images)
            .where(
                and(
                    eq(schema.images.orgId, orgId),
                    eq(schema.images.clusterId, clusterId),
                    eq(schema.images.control, "unknown"),
                ),
            );
        if (undecided.length > 0)
            await resolveImageControl(
                orgId,
                undecided.map((i) => i.id),
            );
    } catch (error) {
        log.warn({ error, orgId, clusterId }, "Could not resolve image control after the inventory report");
    }
}

/** Every org that has images — what the backfill and the nightly pass iterate. */
export async function orgsWithImages(): Promise<string[]> {
    const rows = await db.selectDistinct({ orgId: schema.images.orgId }).from(schema.images);
    return rows.map((r) => r.orgId);
}

/** A rule's registry, normalised the way image rows are compared; blank is "any registry". */
export function normalizeRuleRegistry(registry: string | null | undefined): string | null {
    const trimmed = registry?.trim();
    return trimmed ? normalizeRegistry(trimmed) : null;
}
