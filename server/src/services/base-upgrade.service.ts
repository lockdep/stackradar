/**
 * "Rebuilding on `node:20.18-bookworm-slim` removes 212 of 231 base-image
 * findings" — the one action the base bucket turns into (component tier
 * plan, item 7).
 *
 * Two halves, because the measurement needs an SBOM of an image nobody in the
 * org runs:
 *
 *   - **The nightly pass** ({@link refreshBaseChecks}) — for every public
 *     base ref some image is built on: what the tag points to today, and the
 *     newest comparable newer tag (`lib/image-tags.ts` decides what is
 *     comparable and refuses the rest). Both digests are queued for the
 *     platform scanner, which already has the size pre-flight and the
 *     rate-limit handling. Bounded per run; a 429 ends it.
 *   - **The read** ({@link baseUpgradeForImage}, {@link baseUpgradesForOrg}) —
 *     the image's own base-bucket findings, diffed against the candidate
 *     base's findings. Computed, never stored: both sides move with the
 *     advisory mirror.
 *
 * What it refuses to say, in the image-upgrade vocabulary
 * (`UpgradeAvailability`): `no-candidates` — the base is not a public,
 * tagged ref; `not-measured` — nobody has checked it yet, or the candidate
 * is not scanned; `up-to-date`; `ambiguous-ordering`. A base with no newer
 * tag says so rather than showing nothing.
 *
 * Two candidates are weighed. **Same tag, today's digest**: a rebuild with
 * no Dockerfile change, offered only when the tag has actually moved — the
 * image's base layers are no longer what the tag points to. **A newer tag**:
 * the same variant, the same major where one exists. The one that removes
 * more wins; a tie goes to the smaller change.
 *
 * Advice only. Nothing here can rebuild anything.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { listTags, openSession, resolveDigest, type RegistryOptions } from "../chart-render/registry.js";
import { comparableFindings, type ComparableFinding } from "../db/finding-delta.js";
import { bestNewerTag, bumpKind, parseTag, type VersionBump } from "../lib/image-tags.js";
import { chainHash } from "../lib/base-image.js";
import { isPublicRegistry, normalizeRegistry, pairRepository } from "../lib/public-registries.js";
import { IMAGE_TOO_LARGE } from "../lib/job-failure.js";
import { parseImageRef } from "../lib/image-ref.js";
import { jobRepository } from "../repositories/job.repository.js";
import { scannedImages } from "../repositories/container-history.repository.js";
import { ensurePlatform, findPlatform } from "./platform.service.js";
import type { UpgradeAvailability } from "./upgrade-recommendation.service.js";
import type { BaseCheckAvailability } from "../db/schema/base-image-checks.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("base-upgrade");

/** A base ref worth asking a registry about: public, with a tag. */
export interface BaseRef {
    registry: string;
    repository: string;
    tag: string;
}

/** `node:20-bookworm-slim` → docker.io / library/node / 20-bookworm-slim. Null for anything not public and tagged. */
export function parseBaseRef(ref: string | null | undefined): BaseRef | null {
    if (!ref) return null;
    const parsed = parseImageRef(ref);
    if (!parsed.repository || !parsed.tag) return null;
    const registry = normalizeRegistry(parsed.registry);
    if (!isPublicRegistry(registry)) return null;
    return { registry, repository: pairRepository(registry, parsed.repository), tag: parsed.tag };
}

const displayRef = (base: BaseRef, tag: string) =>
    `${base.registry === "docker.io" ? "" : `${base.registry}/`}${base.repository.replace(/^library\//, "")}:${tag}`;

/**
 * The newer tag to propose: the newest comparable one in the **same major**
 * when there is one — a runtime's major is a migration, not a rebuild — and
 * the newest overall otherwise, which the caller flags as a major bump.
 */
export function pickNewerTag(
    current: string,
    tags: readonly string[],
): { tag: string | null; availability: BaseCheckAvailability; skipped: Array<{ tag: string; reason: string }> } {
    const { newer, incomparable } = bestNewerTag(current, [...tags]);
    // Thousands of tags are incomparable on a busy repository; keep the ones that look like versions.
    const skipped = incomparable.filter((s) => parseTag(s.tag).version !== null).slice(0, 10);
    if (newer.length === 0) {
        return {
            tag: null,
            availability: parseTag(current).version === null ? "ambiguous-ordering" : "up-to-date",
            skipped,
        };
    }
    const major = parseTag(current).version?.[0];
    const sameMajor = newer.find((t) => parseTag(t).version?.[0] === major);
    return { tag: sameMajor ?? newer[0]!, availability: "available", skipped };
}

// ─── The nightly pass ─────────────────────────────────────────────────────

export interface BaseCheckStats {
    bases: number;
    checked: number;
    scansQueued: number;
    rateLimited: boolean;
}

/** Re-ask a registry about a base at most this often. */
const RECHECK_AFTER_HOURS = 20;

export async function refreshBaseChecks(limit: number, opts: RegistryOptions): Promise<BaseCheckStats> {
    const stats: BaseCheckStats = { bases: 0, checked: 0, scansQueued: 0, rateLimited: false };

    const refs = await db
        .selectDistinct({ ref: schema.images.baseImageRef })
        .from(schema.images)
        .where(and(isNotNull(schema.images.baseImageRef), isNotNull(schema.images.baseLayerCount)));
    const bases = new Map<string, BaseRef>();
    for (const { ref } of refs) {
        const base = parseBaseRef(ref);
        if (base) bases.set(`${base.registry}/${base.repository}:${base.tag}`, base);
    }
    stats.bases = bases.size;
    if (bases.size === 0) return stats;

    const fresh = await db
        .select({
            registry: schema.baseImageChecks.registry,
            repository: schema.baseImageChecks.repository,
            tag: schema.baseImageChecks.tag,
        })
        .from(schema.baseImageChecks)
        .where(sql`${schema.baseImageChecks.checkedAt} > now() - make_interval(hours => ${RECHECK_AFTER_HOURS})`);
    for (const row of fresh) bases.delete(`${row.registry}/${row.repository}:${row.tag}`);

    const toScan: Array<{ registry: string; repository: string; digest: string }> = [];
    for (const base of [...bases.values()].slice(0, limit)) {
        const session = openSession(base, opts);
        const tags = await listTags(session);
        if (!tags.ok) {
            if (tags.rateLimited) {
                stats.rateLimited = true;
                log.warn({ registry: base.registry }, "Registry rate limit reached; ending the base check run");
                break;
            }
            continue;
        }

        const current = await resolveDigest(base, opts);
        const picked = pickNewerTag(base.tag, tags.tags);
        const newer = picked.tag ? await resolveDigest({ ...base, tag: picked.tag }, opts) : null;

        const row = {
            registry: base.registry,
            repository: base.repository,
            tag: base.tag,
            currentDigest: current.ok ? current.digest : null,
            availability: picked.availability,
            newerTag: picked.tag,
            newerDigest: newer?.ok ? newer.digest : null,
            skipped: picked.skipped,
            checkedAt: new Date(),
        };
        await db
            .insert(schema.baseImageChecks)
            .values(row)
            .onConflictDoUpdate({
                target: [
                    schema.baseImageChecks.registry,
                    schema.baseImageChecks.repository,
                    schema.baseImageChecks.tag,
                ],
                set: row,
            });
        stats.checked += 1;

        for (const digest of [row.currentDigest, row.newerDigest]) {
            if (digest) toScan.push({ registry: base.registry, repository: base.repository, digest });
        }
    }

    stats.scansQueued = await queuePlatformScans(toScan);
    return stats;
}

/** Queue a platform scan for each digest that has no SBOM, no open job, and was not refused for size. */
async function queuePlatformScans(
    targets: Array<{ registry: string; repository: string; digest: string }>,
): Promise<number> {
    if (targets.length === 0) return 0;
    const { orgId, clusterId } = await ensurePlatform();
    const digests = [...new Set(targets.map((t) => t.digest))];

    const [have, open, refused] = await Promise.all([
        db
            .select({ digest: schema.images.digest })
            .from(schema.images)
            .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
            .where(and(eq(schema.images.clusterId, clusterId), inArray(schema.images.digest, digests))),
        jobRepository.openParamKeys("platform_scan", (p) => p["digest"]),
        jobRepository.failedParamKeys("platform_scan", IMAGE_TOO_LARGE, (p) => p["digest"]),
    ]);
    const covered = new Set([...have.map((h) => h.digest), ...open, ...refused]);

    let queued = 0;
    for (const target of targets) {
        if (covered.has(target.digest)) continue;
        covered.add(target.digest);
        await jobRepository.create({
            orgId,
            type: "platform_scan",
            title: `${target.repository}@${target.digest.slice(0, 19)}: Platform Scan (base image)`,
            triggeredBy: "system",
            priority: 2,
            params: { digest: target.digest, registry: target.registry, repository: target.repository },
        });
        queued += 1;
    }
    return queued;
}

// ─── The read ─────────────────────────────────────────────────────────────

export interface BaseCandidate {
    /** `same-tag`: the tag moved since the image was built — rebuild, no Dockerfile change. */
    kind: "same-tag" | "newer-tag";
    ref: string;
    tag: string;
    digest: string;
    bump: VersionBump;
    /** Base-image findings of the image that the candidate base does not carry. */
    removes: number;
    removesKev: number;
    removesHigh: number;
    /** Findings the candidate base carries that the image does not have at all. */
    introduces: number;
    /** Risk Score contribution of what it removes, less what it introduces. */
    riskRemoved: number;
}

export interface BaseUpgradeRecommendation {
    base: { ref: string; layerCount: number | null };
    availability: UpgradeAvailability;
    /** The image's findings in the base bucket — the *M* of "removes N of M". */
    baseFindings: number;
    best: BaseCandidate | null;
    candidates: BaseCandidate[];
    skipped: Array<{ tag: string; reason: string }>;
}

const HIGH_OR_WORSE = new Set(["critical", "high"]);

/** Pure: what rebuilding on `candidate` does to the base-bucket findings of `image`. */
export function measureCandidate(image: readonly ComparableFinding[], candidate: readonly ComparableFinding[]) {
    const candidateKeys = new Set(candidate.map((f) => f.key));
    const imageKeys = new Set(image.map((f) => f.key));
    const base = image.filter((f) => f.bucket === "base");
    const removed = base.filter((f) => !candidateKeys.has(f.key));
    const introduced = candidate.filter((f) => !imageKeys.has(f.key));
    const sum = (rows: readonly ComparableFinding[]) => rows.reduce((n, f) => n + f.riskScore, 0);
    return {
        baseFindings: base.length,
        removes: removed.length,
        removesKev: removed.filter((f) => f.kevListed).length,
        removesHigh: removed.filter((f) => HIGH_OR_WORSE.has((f.severityLevel ?? "").toLowerCase())).length,
        introduces: introduced.length,
        riskRemoved: Math.round(sum(removed) - sum(introduced)),
    };
}

interface ImageBase {
    imageId: string;
    baseImageRef: string | null;
    baseLayerCount: number | null;
}

/**
 * Recommendations for a set of images in one pass: one read of the checks,
 * one of the platform's images, one of the layer chains, one
 * `comparableFindings`. The org page calls it with every image it lists.
 */
async function recommend(images: readonly ImageBase[]): Promise<Map<string, BaseUpgradeRecommendation>> {
    const out = new Map<string, BaseUpgradeRecommendation>();
    const withBase = images.filter((i) => i.baseImageRef);
    if (withBase.length === 0) return out;

    const parsed = new Map(withBase.map((i) => [i.imageId, parseBaseRef(i.baseImageRef)]));
    const bases = [
        ...new Set([...parsed.values()].filter((b): b is BaseRef => b !== null).map((b) => JSON.stringify(b))),
    ].map((s) => JSON.parse(s) as BaseRef);

    const checks =
        bases.length === 0
            ? []
            : await db
                  .select()
                  .from(schema.baseImageChecks)
                  .where(
                      sql`(${schema.baseImageChecks.registry}, ${schema.baseImageChecks.repository}, ${schema.baseImageChecks.tag}) IN (${sql.join(
                          bases.map((b) => sql`(${b.registry}, ${b.repository}, ${b.tag})`),
                          sql`, `,
                      )})`,
                  );
    const checkOf = (b: BaseRef) =>
        checks.find((c) => c.registry === b.registry && c.repository === b.repository && c.tag === b.tag);

    // The platform's scanned copies of the candidate digests.
    const platform = await findPlatform();
    const digests = [
        ...new Set(checks.flatMap((c) => [c.currentDigest, c.newerDigest]).filter((d): d is string => d !== null)),
    ];
    const platformRows =
        platform && digests.length > 0
            ? await db
                  .select({ id: schema.images.id, digest: schema.images.digest })
                  .from(schema.images)
                  .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
                  .where(and(eq(schema.images.clusterId, platform.clusterId), inArray(schema.images.digest, digests)))
            : [];
    // An SBOM whose matching pass has not succeeded has zero findings on
    // record, and would read as "removes everything".
    const matched = await scannedImages(
        db,
        platformRows.map((p) => p.id),
    );
    const platformByDigest = new Map(platformRows.filter((p) => matched.has(p.id)).map((p) => [p.digest, p.id]));

    // Layer chains, to tell whether the tag has moved since the image was built.
    const chainIds = [...new Set([...withBase.map((i) => i.imageId), ...platformByDigest.values()])];
    const chainRows = await db
        .select({
            imageId: schema.imageLayers.imageId,
            diffIds: sql<string[]>`array_agg(${schema.imageLayers.diffId} ORDER BY ${schema.imageLayers.rootfsIndex})`,
        })
        .from(schema.imageLayers)
        .where(and(inArray(schema.imageLayers.imageId, chainIds), isNotNull(schema.imageLayers.diffId)))
        .groupBy(schema.imageLayers.imageId);
    const chainOfImage = new Map(chainRows.map((r) => [r.imageId, r.diffIds]));

    const findings = await comparableFindings([
        ...new Set([...withBase.map((i) => i.imageId), ...platformByDigest.values()]),
    ]);

    for (const image of withBase) {
        const base = parsed.get(image.imageId) ?? null;
        const own = findings.get(image.imageId) ?? [];
        const empty: BaseUpgradeRecommendation = {
            base: { ref: image.baseImageRef!, layerCount: image.baseLayerCount },
            availability: "no-candidates",
            baseFindings: own.filter((f) => f.bucket === "base").length,
            best: null,
            candidates: [],
            skipped: [],
        };
        if (!base) {
            out.set(image.imageId, empty);
            continue;
        }
        const check = checkOf(base);
        if (!check) {
            out.set(image.imageId, { ...empty, availability: "not-measured" });
            continue;
        }

        const candidates: BaseCandidate[] = [];
        let unmeasured = 0;
        const consider = (kind: BaseCandidate["kind"], tag: string, digest: string | null) => {
            if (!digest) return;
            const platformImageId = platformByDigest.get(digest);
            if (!platformImageId) {
                unmeasured += 1;
                return;
            }
            const measured = measureCandidate(own, findings.get(platformImageId) ?? []);
            candidates.push({
                kind,
                ref: displayRef(base, tag),
                tag,
                digest,
                bump: bumpKind(base.tag, tag),
                ...measured,
            });
        };

        // Same tag: only when the tag has moved — the image's base layers are
        // not the chain the tag resolves to today. Unknown chains say nothing.
        const ownChain = chainOfImage.get(image.imageId);
        const currentPlatformId = check.currentDigest ? platformByDigest.get(check.currentDigest) : undefined;
        const currentChain = currentPlatformId ? chainOfImage.get(currentPlatformId) : undefined;
        if (ownChain && currentChain && image.baseLayerCount !== null) {
            const moved = chainHash(ownChain.slice(0, image.baseLayerCount)) !== chainHash(currentChain);
            if (moved) consider("same-tag", base.tag, check.currentDigest);
        } else if (check.currentDigest && !currentPlatformId) {
            unmeasured += 1;
        }
        if (check.newerTag) consider("newer-tag", check.newerTag, check.newerDigest);

        // What removes more wins; a tie is the smaller change.
        candidates.sort((a, b) => b.removes - a.removes || (a.kind === "same-tag" ? -1 : 1));
        const best = candidates.find((c) => c.removes > 0) ?? null;

        const availability: UpgradeAvailability = best
            ? "available"
            : unmeasured > 0
              ? "not-measured"
              : check.availability === "available" || candidates.length > 0
                ? "up-to-date" // measured, and rebuilding removes nothing
                : check.availability;

        out.set(image.imageId, {
            ...empty,
            availability,
            best,
            candidates,
            skipped: check.skipped,
        });
    }
    return out;
}

/** One image, org-scoped: another org's image id answers null, as if it did not exist. */
export async function baseUpgradeForImage(orgId: string, imageId: string): Promise<BaseUpgradeRecommendation | null> {
    const [image] = await db
        .select({
            imageId: schema.images.id,
            baseImageRef: schema.images.baseImageRef,
            baseLayerCount: schema.images.baseLayerCount,
        })
        .from(schema.images)
        .where(and(eq(schema.images.id, imageId), eq(schema.images.orgId, orgId)));
    if (!image) return null;
    return (await recommend([image])).get(imageId) ?? null;
}

/** Every image of the org that has a known base — the Fixes page's base rebuilds. */
export async function baseUpgradesForOrg(
    orgId: string,
    imageIds?: readonly string[],
): Promise<Map<string, BaseUpgradeRecommendation>> {
    const images = await db
        .select({
            imageId: schema.images.id,
            baseImageRef: schema.images.baseImageRef,
            baseLayerCount: schema.images.baseLayerCount,
        })
        .from(schema.images)
        .where(
            and(
                eq(schema.images.orgId, orgId),
                isNotNull(schema.images.baseImageRef),
                imageIds ? inArray(schema.images.id, [...imageIds]) : undefined,
            ),
        );
    return recommend(images);
}
