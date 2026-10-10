import { count, countDistinct, sql, isNull, isNotNull, desc, asc, eq, and, or, ilike, inArray, notExists, exists, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isCurrentGeneration } from "../db/generation.js";
import { deployedImages, severityRowsByImage } from "../db/findings.js";
import { scannedImageIds } from "./image.repository.js";
import { IMAGE_GC_RETENTION_DAYS, imageGcRetentionDays } from "../config/image-gc.js";
import { isFeedStale, FEED_STALE_AFTER_HOURS } from "../lib/feed-health.js";
import { purlTypeForFamily } from "../matching/index.js";
import type { JobStatus } from "../db/schema/jobs.js";
import type { OsvRange, OsvReference } from "../db/schema/vulnerabilities.js";
import { edition } from "../edition.js";
import { ECOSYSTEMS_ENV_VAR, parseEcosystems } from "../osv-sync/ecosystems.js";

/**
 * The figures that say whether the worker is healthy *now*.
 *
 * `byStatus` cannot: it counts every job ever created, so `completed` grows
 * without bound and drowns the three counts that change. A queue with 400k
 * completed jobs and one pending job three hours old looks identical to a
 * healthy one there. These three do not accumulate — each is either a live
 * measurement or a bounded window.
 */
export interface AdminQueueHealth {
  /**
   * How long the oldest `pending` job has been waiting, in seconds. Null when
   * nothing is pending, which is the healthy steady state — not zero, because
   * zero reads as "a job just arrived".
   *
   * `pending` only: a `scheduled` job waiting for its time is doing exactly what
   * it was asked to, and counting it would make every nightly scan look stuck.
   * Measured with the database clock so it cannot drift from the timestamps it
   * is subtracting.
   */
  oldestPendingAgeSeconds: number | null;
  /**
   * Terminal outcomes in the last 24 hours, keyed on `completed_at` so the
   * window is "what the worker finished", not "what was created".
   *
   * `cancelled` is deliberately absent from both figures: a cancellation is a
   * person's decision, not a worker outcome, and putting it in the denominator
   * would let a burst of cancellations dilute a real failure rate.
   */
  last24h: {
    completed: number;
    failed: number;
  };
  /**
   * Failed jobs that have spent every retry — `retryJob()` refuses these
   * (`job.service.ts:232`), so nothing will move them without a person. They sit
   * in `byStatus.failed` alongside jobs that will retry themselves, which is why
   * that number never reads as a call to action.
   */
  stuckAtMaxRetries: number;
}

export interface AdminSystemStats {
  organizations: {
    total: number;
    byPlan: Record<string, number>;
  };
  users: {
    total: number;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    health: AdminQueueHealth;
  };
  vulnerabilities: {
    /** Advisories the matcher can actually work with — withdrawn ones excluded. */
    total: number;
    /** The advisories `total` leaves out, so the mirror size stays legible. */
    withdrawn: number;
    bySeverity: Record<string, number>;
    /**
     * Active advisories carrying no CVSS score.
     *
     * The `unknown` severity bucket is not this number. `unknown` means we could
     * not derive a *level*; this means there is no *score* to derive one from.
     * They diverge in both directions — a GHSA with a `database_specific`
     * severity string but no CVSS vector lands in a named bucket while counting
     * here — and only this one answers "how much of the mirror can be ranked".
     */
    withoutCvssScore: number;
    affectedPackagesTotal: number;
  };
  sboms: {
    total: number;
  };
  components: {
    total: number;
    withVulnerabilities: number;
  };
  /**
   * The `images` table itself, platform-wide and across every tenant.
   *
   * `total` is the only number here that is not reachable from any other
   * surface: every other image figure on the dashboard is scoped to one org's
   * deployments, so an image nobody runs — a cluster-free upload, or the
   * leftovers of a deleted cluster — is invisible to all of them. The gap
   * between `total` and `withSbom` is the ingest backlog, and `orphaned` is
   * what the nightly GC is aiming at.
   */
  images: {
    total: number;
    withSbom: number;
    /** No `workload_containers` row anywhere — a GC candidate once it ages out. */
    orphaned: number;
    /**
     * Running somewhere, with no SBOM — the ingest backlog.
     *
     * Not `total - withSbom`: that difference also swallows the orphaned
     * images nobody runs, which are the GC's problem and not the scanner's.
     */
    awaitingSbom: number;
  };
  /**
   * The Kubernetes inventory, counted once across all tenants.
   *
   * `containers` counts `workload_containers` rows, not distinct images: one
   * digest running in forty places is forty rows here and one row in `images`.
   * The ratio between the two is the whole argument for keying on the digest,
   * which is why both are on the same screen.
   */
  kubernetes: {
    clusters: number;
    namespaces: number;
    workloads: number;
    containers: number;
    helmReleases: number;
  };
}

export interface AdminOsvStatus {
  state: {
    initialized: boolean;
    syncStatus: string;
    lastSuccessfulPollAt: Date | null;
    // Both watermarks, not just the applied one. Applied-age alone conflates
    // "OSV has published nothing for two hours" (healthy) with "we are two
    // hours behind" (not) — the difference between them is the lag.
    lastModifiedSeen: Date | null;
    lastModifiedApplied: Date | null;
    lastFullRefreshAt: Date | null;
    affectedPkgGeneration: number;
    consecutiveFailures: number;
    lastError: string | null;
    updatedAt: Date;
    /**
     * The OSV directories the live generation was built from, or null for
     * the whole corpus (`OSV_ECOSYSTEMS`, open-source plan step 06). What
     * the mirror *contains*; `configuredEcosystems` is what the process
     * wants, and the two differ when the variable changed after the last
     * bootstrap.
     */
    ecosystems: string[] | null;
  } | null;
  /** The process's `OSV_ECOSYSTEMS` as resolved by `osv-sync/ecosystems.ts`; null for everything. */
  configuredEcosystems: string[] | null;
  /**
   * Row counts per generation of `vulnerability_affected_packages`.
   *
   * Normally one entry. Two during a rebuild — the live generation serving
   * reads and the one being built beside it — which is the only progress
   * indicator a multi-hour bootstrap has. A lingering third would mean a
   * previous rebuild died before `discardGeneration()` could clean up after
   * it, which is otherwise invisible and shows up only as a table twice the
   * size it should be.
   */
  generations: Array<{ generation: number; rowCount: number; isCurrent: boolean }>;
  recentRuns: Array<{
    id: string;
    mode: string;
    success: boolean;
    recordsProcessed: number;
    inserted: number;
    updated: number;
    // Real since the upsert started returning `(xmax = 0)`. Previously this and
    // `updated` were both permanently 0, which is why nothing rendered them.
    unchanged: number;
    parseFailures: number;
    durationMs: number;
    lagSeconds: number | null;
    startedAt: Date;
    completedAt: Date;
  }>;
  /**
   * Records the mirror could not take: the advisory is *missing*. Anything
   * above zero here means the mirror has a hole.
   */
  parseFailures: {
    total: number;
    last7Days: number;
    byType: Record<string, number>;
  };
  /**
   * Records that deviated from the OSV JSON schema and were ingested anyway.
   * Not a data-loss signal — mostly upstream publishers violating the spec
   * (openSUSE ships references with no `url`), plus anything our vendored
   * schema is too old to recognise. Kept separate from `parseFailures`
   * because conflating them reported ~25,000 "failures" for a mirror that
   * had lost nothing, which made the real number unwatchable.
   */
  validationWarnings: {
    total: number;
    last7Days: number;
  };
}

/**
 * The three daily feed syncs beside the OSV mirror: EPSS, KEV and Artifact Hub.
 *
 * Each is a single overwritten state row (`threat-intel.ts`, `artifact-hub.ts`)
 * rather than a run history, so this reports the last run and nothing older.
 * A failed run records `lastError` without touching `lastSyncedAt` — the two
 * move independently, and both are surfaced for exactly that reason: fresh data
 * plus an error means "last night's attempt failed, yesterday's data is live".
 *
 * The `stale` flags are computed here with `isFeedStale()` so this endpoint and
 * the `--metrics` CLIs cannot disagree about the threshold; `staleAfterHours`
 * carries the threshold itself so the UI can caption it without duplicating the
 * constant.
 */
export interface AdminFeedsStatus {
  staleAfterHours: number;
  epss: {
    state: {
      lastSyncedAt: Date | null;
      /** The age the data claims (`score_date` from the CSV header), as distinct from when we fetched it. */
      lastScoreDate: string | null;
      rowsInFile: number | null;
      rowsMatched: number | null;
      /** Expected to be tens of thousands — EPSS scores every CVE, the mirror holds only ecosystem advisories. */
      rowsUnmatched: number | null;
      lastError: string | null;
      updatedAt: Date;
    } | null;
    stale: boolean;
    /** Advisories currently carrying a score — what the feed has actually decorated, not what the last run touched. */
    advisoriesWithScore: number;
  };
  kev: {
    state: {
      lastSyncedAt: Date | null;
      catalogVersion: string | null;
      releasedAt: Date | null;
      entriesInCatalog: number | null;
      entriesMatched: number | null;
      /** Advisories whose KEV columns the run cleared because CISA withdrew the CVE. Rare but load-bearing. */
      entriesCleared: number | null;
      lastError: string | null;
      updatedAt: Date;
    } | null;
    stale: boolean;
    advisoriesListed: number;
  };
  artifactHub: {
    state: {
      lastSyncedAt: Date | null;
      packagesInDump: number | null;
      packagesApplied: number | null;
      /** Attribution counters are a separate write after the mirror pass — null until it runs. */
      chartsExamined: number | null;
      attributionsWritten: number | null;
      attributionsRefused: number | null;
      reposAutoAdded: number | null;
      lastError: string | null;
      updatedAt: Date;
    } | null;
    stale: boolean;
    /** Live row counts — what the stamp-and-prune mirror holds now, not what the last run applied. */
    mirrorPackages: number;
    attributions: number;
  };
}

export interface AdminEcosystemEntry {
  ecosystem: string;
  count: number;
}

export interface AdminWithdrawnStats {
  /** Advisories in the mirror that OSV has since retracted. */
  advisories: number;
  /**
   * Customer findings that still point at a retracted advisory.
   *
   * The matcher refuses to create these — `matching/store.ts` filters
   * `withdrawn = false` out of the candidate query and `matching/match.ts`
   * drops withdrawn candidates again — but nothing retracts a match made
   * *before* the withdrawal. `bulkLinkComponentVulnerabilities` is insert +
   * onConflictDoUpdate only, and the sole DELETE against
   * `component_vulnerabilities` is component-cascade cleanup. So a non-zero
   * value here is not history: it is a finding being shown to a customer right
   * now for an advisory that no longer exists.
   *
   * `components` and `advisories` give the blast radius — how many customer
   * components are affected, and how few (or many) retractions caused it.
   */
  staleFindings: {
    links: number;
    components: number;
    advisories: number;
  };
  /**
   * Affected-package rows whose denormalised `withdrawn` flag still reads false
   * while the advisory itself is withdrawn.
   *
   * The schema comment on `vulnerability_affected_packages.withdrawn` asserts
   * both sync paths derive the flag from the OSV record at extract time, so the
   * two can never disagree. Nothing verified that assertion until this number.
   * Non-zero means `vuln_affected_pkg_match_key_idx` — partial on
   * `withdrawn = false` — is still serving the matcher candidates it was built
   * to exclude. A permanent zero is the cheapest proof the invariant holds.
   */
  denormalizationDrift: number;
}

/**
 * The key every match-metadata distribution uses for a NULL column.
 *
 * Not "unknown": these columns were added after the matcher was already writing
 * rows, so a null means the link predates the column rather than that the
 * matcher failed to decide. Those rows cannot be audited at all, which makes the
 * size of this bucket a figure in its own right — it shrinks to zero only once
 * every SBOM has been rescanned.
 */
export const UNRECORDED = "unrecorded";

/** One (OSV family → component PURL type) pair the matcher linked across. */
export interface AdminEcosystemDisagreement {
  /** The family part of `matched_ecosystem`: 'Alpine', 'Debian', 'npm'. */
  family: string;
  /** The PURL type that family is published under, per `matching/ecosystem.ts`. */
  expectedPurlType: string;
  /** The PURL type the component actually is. */
  componentPurlType: string;
  count: number;
}

export interface AdminMatcherQuality {
  /** Every row in `component_vulnerabilities` — the denominator for all of these. */
  total: number;
  /** 'direct' vs 'indirect' — did the component match itself, or its `upstream=` source package. */
  byMatchType: Record<string, number>;
  /** 'exact' / 'fuzzy' / 'unconfirmed' — how sure the version comparison was. */
  byMatchConfidence: Record<string, number>;
  /** 'purl' / 'cpe' / 'name_version' — which identity carried the match. */
  byMatchedBy: Record<string, number>;
  /**
   * Whether the advisory's ecosystem and the component's PURL type describe the
   * same kind of package.
   *
   * `matching/ecosystem.ts` maps each OSV family to exactly one PURL type, so
   * this comparison has a right answer: an advisory from `Alpine` belongs on an
   * `apk` component. A `golang` component carrying a `Debian` advisory is the
   * shape of a match-key or release-scoping leak, and it is invisible per
   * component — the Explorer shows one match at a time, and one crossed pair
   * looks like a curiosity rather than a class.
   */
  ecosystemAgreement: {
    agreeing: number;
    disagreeing: number;
    /** `matched_ecosystem` is null — provenance predates the column. */
    unrecorded: number;
    /**
     * Recorded, but one side maps to nothing: an OSV family outside the
     * `ECOSYSTEMS` table (`GitHub Actions`, `Linux`, `OSS-Fuzz`) or a component
     * with no parseable PURL. Neither is a defect — it is the set this question
     * cannot be asked of, kept separate so it never inflates either verdict.
     */
    unresolvable: number;
    /** Worst crossed pairs first. Capped — see `getMatcherQuality`. */
    topDisagreements: AdminEcosystemDisagreement[];
  };
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

/**
 * What an admin should do about an image, as one word.
 *
 * The three are ordered by precedence, not by exclusivity — an image can be
 * orphaned *and* carry an SBOM (a cluster-free upload, or the remains of a
 * deleted cluster), and orphaned wins, because that is the fact with a deadline
 * attached. `hasSbom` and `containerCount` are reported alongside so nothing is
 * hidden by the collapse.
 */
export type AdminImageState = "orphaned" | "awaiting_sbom" | "scanned";

/**
 * One row of the `images` table, with everything reachable from a digest.
 *
 * Deliberately not scoped to a tenant — this is the platform operator's view
 * across every org. Since ADR 0006 an image belongs to one cluster, so the
 * org/cluster counts below are 1 for any row with containers; they survive as
 * columns because a drifted count would be the symptom of a broken invariant.
 * This shape must never leak past `requireAdmin`: "which tenant runs what" is
 * provenance and belongs to them.
 */
export interface AdminImage {
  id: string;
  digest: string;
  registry: string | null;
  repository: string | null;
  firstSeenAt: Date;
  /** What the GC ages on. Bumped by any inventory report or upload naming the digest. */
  lastSeenAt: Date;
  sbomId: string | null;
  sbomFormat: string | null;
  sbomCreatedAt: Date | null;
  componentCount: number;
  /**
   * `null` means nobody has matched this image yet — never conflate with zero.
   * Same rule as the customer-facing image list, via `scannedImageIds`.
   */
  findings: SeverityCounts | null;
  /** `workload_containers` rows pointing here, across every tenant. */
  containerCount: number;
  /** Distinct orgs running it — 1 under ADR 0006 unless an invariant broke. */
  orgCount: number;
  /** Distinct clusters running it. */
  clusterCount: number;
  state: AdminImageState;
  /**
   * Days until the GC's cutoff reaches this image; zero or negative once it is
   * already past. `null` unless the image is orphaned, because for anything
   * still referenced the countdown does not apply — reachability is re-checked
   * under a lock at collection time.
   *
   * Computed against the owning org's *plan* window (`imageGcRetentionDays`),
   * not a global constant — the archive window is a plan axis, so two
   * orphaned images the same age can legitimately show different countdowns.
   *
   * Rounded **up**, so `n` means "gone within n days" and only a genuinely
   * expired image reports zero. Rounding down would put every image in its
   * final 24 hours at zero, and the UI renders zero as "Due" — a day of images
   * claiming to be collectable before they are.
   */
  gcInDays: number | null;
}

export type AdminImageSort = "lastSeen" | "firstSeen" | "repository";

export interface AdminImagesPage {
  images: AdminImage[];
  /** Matching the filters, before the page window — the pager needs it. */
  total: number;
  limit: number;
  offset: number;
  /**
   * The unfiltered state breakdown, so switching filters never changes the
   * counts in the filter control itself.
   */
  stateTotals: Record<AdminImageState, number>;
  /**
   * Echoed so the countdown column can explain itself without a second call.
   * The GC *floor* (free/default window) — paid orgs keep images for their
   * plan's `historyDays` instead, which `gcInDays` already accounts for.
   */
  retentionDays: number;
}

export interface ExplorerImage {
  imageId: string;
  digest: string;
  registry: string | null;
  repository: string | null;
  sbomId: string;
  format: string;
  generatedAt: Date | null;
  createdAt: Date;
  /** How many `workload_containers` reference this image, across the org. */
  deploymentCount: number;
  componentCount: number;
  vulnCounts: SeverityCounts;
}

export interface ExplorerSbom {
  id: string;
  format: string;
  specVersion: string;
  sourceName: string | null;
  digest: string;
  toolName: string | null;
  toolVersion: string | null;
  generatedAt: Date | null;
  createdAt: Date;
  componentCount: number;
  vulnCounts: SeverityCounts;
}

export interface ExplorerComponent {
  id: string;
  name: string;
  version: string | null;
  type: string;
  purl: string | null;
  groupName: string | null;
  isDirect: boolean | null;
  scope: string | null;
  vulnCounts: SeverityCounts;
}

export interface ExplorerComponentsPage {
  components: ExplorerComponent[];
  total: number;
  limit: number;
  offset: number;
}

export interface ExplorerAffectedPackage {
  ecosystem: string | null;
  packageName: string;
  purl: string | null;
  versions: string[];
  ranges: OsvRange[];
  fixedVersion: string | null;
}

export interface ExplorerComponentVulnerability {
  id: string;
  vulnId: string;
  summary: string | null;
  details: string | null;
  severityLevel: string | null;
  cvssScore: number | null;
  aliases: string[];
  references: OsvReference[];
  publishedAt: Date | null;
  modifiedAt: Date | null;
  matchedBy: string | null;
  matchConfidence: string | null;
  // Recorded by the matcher at match time. `affectedPackages` below lists every
  // affected[] entry of the advisory; these say which one actually won and why,
  // which is the whole question this view exists to answer.
  matchType: string | null;
  matchedEcosystem: string | null;
  matchedFixedVersion: string | null;
  upstreamName: string | null;
  upstreamVersion: string | null;
  affectedPackages: ExplorerAffectedPackage[];
}

export interface ExplorerComponentDetail {
  component: {
    id: string;
    name: string;
    version: string | null;
    type: string;
    purl: string | null;
    cpe: string | null;
    groupName: string | null;
    isDirect: boolean | null;
    scope: string | null;
  };
  vulnerabilities: ExplorerComponentVulnerability[];
}

/**
 * Every mirror figure on this dashboard is read as "what the matcher can work
 * with", so every one of them excludes withdrawn advisories — the matcher will
 * not match against a retracted advisory, and counting them inflated the
 * headline mirror size past anything actually usable. The excluded advisories
 * are not hidden; `getWithdrawnStats()` reports them as their own figure.
 */
const isActiveAdvisory = () => isNull(schema.vulnerabilities.withdrawnAt);
const isWithdrawnAdvisory = () => isNotNull(schema.vulnerabilities.withdrawnAt);

/**
 * The affected-package equivalent: live generation *and* not withdrawn. The
 * generation half is mandatory for any read of this table (see db/generation.ts);
 * the withdrawn half is what keeps the entry counts consistent with the advisory
 * counts above.
 */
const isActiveAffectedPackage = () =>
  and(isCurrentGeneration(), eq(schema.vulnerabilityAffectedPackages.withdrawn, false));

/** Advisories with no CVSS score — see AdminSystemStats.vulnerabilities.withoutCvssScore. */
const isUnscoredAdvisory = () => and(isActiveAdvisory(), isNull(schema.vulnerabilities.cvssScore));

/**
 * The three queue-health queries, run together.
 *
 * Split out of `getSystemStats` because `getVulnerabilityStats` has no use for
 * them and a future Jobs-tab caller will.
 */
async function queueHealth(): Promise<AdminQueueHealth> {
  const [oldestRow, outcomeRows, stuckRow] = await Promise.all([
    // now() rather than a JS timestamp: the age is a difference between two
    // database clocks, and mixing in the app's would make it drift.
    db
      .select({
        ageSeconds: sql<string | null>`extract(epoch from now() - min(${schema.jobs.createdAt}))`,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "pending")),

    // Served by jobs_completed_at_idx, which is partial on exactly the terminal
    // statuses this filters to.
    db
      .select({ status: schema.jobs.status, total: count() })
      .from(schema.jobs)
      .where(
        and(
          inArray(schema.jobs.status, ["completed", "failed"] as JobStatus[]),
          sql`${schema.jobs.completedAt} > now() - interval '24 hours'`,
        ),
      )
      .groupBy(schema.jobs.status),

    db
      .select({ total: count() })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.status, "failed"),
          sql`${schema.jobs.retryCount} >= ${schema.jobs.maxRetries}`,
        ),
      ),
  ]);

  const byStatus = new Map(outcomeRows.map((r) => [r.status, Number(r.total)]));

  // extract(epoch ...) is numeric, which node-postgres hands back as a string;
  // an aggregate over no rows is null, and null is the answer we want.
  const rawAge = oldestRow[0]?.ageSeconds;

  return {
    oldestPendingAgeSeconds: rawAge === null || rawAge === undefined ? null : Math.floor(Number(rawAge)),
    last24h: {
      completed: byStatus.get("completed") ?? 0,
      failed: byStatus.get("failed") ?? 0,
    },
    stuckAtMaxRetries: Number(stuckRow[0]?.total ?? 0),
  };
}

const EMPTY_SEVERITY = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

function addSeverity(target: SeverityCounts, level: string | null, n: number) {
  switch (level) {
    case "critical": target.critical += n; break;
    case "high": target.high += n; break;
    case "medium": target.medium += n; break;
    case "low": target.low += n; break;
    default: target.unknown += n; break;
  }
}

/** Component counts grouped per SBOM. */
async function componentCountsBySbom(sbomIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (sbomIds.length === 0) return map;
  const rows = await db
    .select({ sbomId: schema.components.sbomId, total: count() })
    .from(schema.components)
    .where(inArray(schema.components.sbomId, sbomIds))
    .groupBy(schema.components.sbomId);
  for (const r of rows) map.set(r.sbomId, Number(r.total));
  return map;
}

/** How many running containers reference each image, grouped in one pass. */
async function deploymentCountsByImage(imageIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (imageIds.length === 0) return map;
  const rows = await db
    .select({ imageId: schema.workloadContainers.imageId, total: count() })
    .from(schema.workloadContainers)
    .where(inArray(schema.workloadContainers.imageId, imageIds))
    .groupBy(schema.workloadContainers.imageId);
  for (const r of rows) map.set(r.imageId, Number(r.total));
  return map;
}

/** Vulnerability severity counts grouped per SBOM, in a single pass. */
async function severityCountsBySbom(sbomIds: string[]): Promise<Map<string, SeverityCounts>> {
  const bySbom = new Map<string, SeverityCounts>();
  if (sbomIds.length === 0) return bySbom;

  const rows = await db
    .select({
      sbomId: schema.components.sbomId,
      level: schema.vulnerabilities.severityLevel,
      total: count(),
    })
    .from(schema.componentVulnerabilities)
    .innerJoin(schema.components, eq(schema.componentVulnerabilities.componentId, schema.components.id))
    .innerJoin(schema.vulnerabilities, eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id))
    .where(inArray(schema.components.sbomId, sbomIds))
    .groupBy(schema.components.sbomId, schema.vulnerabilities.severityLevel);

  for (const row of rows) {
    let counts = bySbom.get(row.sbomId);
    if (!counts) { counts = EMPTY_SEVERITY(); bySbom.set(row.sbomId, counts); }
    addSeverity(counts, row.level, Number(row.total));
  }
  return bySbom;
}

/**
 * The three image states, as SQL predicates over `images`.
 *
 * Module scope because two surfaces ask the same question and must not answer
 * it differently: the Overview's counts and the Images tab's filter. Spelling
 * "awaiting an SBOM" as `total - withSbom` on one screen and as
 * "has containers and no SBOM" on the other would put two different numbers
 * under the same label — the orphaned-and-unscanned images fall in the gap.
 *
 * They partition `images` exactly once, in the precedence `AdminImageState`
 * documents: orphaned is unqualified and the other two both require a
 * container, so no image can satisfy two of them.
 */
const IMAGE_STATE_FILTERS: Record<AdminImageState, SQL> = {
  orphaned: notExists(
    db.select({ one: sql`1` })
      .from(schema.workloadContainers)
      .where(eq(schema.workloadContainers.imageId, schema.images.id))
  ),
  awaiting_sbom: and(
    exists(
      db.select({ one: sql`1` })
        .from(schema.workloadContainers)
        .where(eq(schema.workloadContainers.imageId, schema.images.id))
    ),
    notExists(
      db.select({ one: sql`1` })
        .from(schema.sboms)
        .where(eq(schema.sboms.imageId, schema.images.id))
    )
  )!,
  scanned: and(
    exists(
      db.select({ one: sql`1` })
        .from(schema.workloadContainers)
        .where(eq(schema.workloadContainers.imageId, schema.images.id))
    ),
    exists(
      db.select({ one: sql`1` })
        .from(schema.sboms)
        .where(eq(schema.sboms.imageId, schema.images.id))
    )
  )!,
};

export const adminRepository = {
  async getSystemStats(): Promise<AdminSystemStats> {
    const [orgRows, planRows, userRow, jobCountRows, jobStatusRows, jobTypeRows, jobHealth, vulnCountRow, withdrawnVulnRow, unscoredVulnRow, vulnSeverityRows, affectedPkgRow, sbomRow, componentRow, componentVulnRow, imageRow, orphanedImageRow, awaitingSbomImageRow, clusterRow, namespaceRow, workloadRow, containerRow, helmReleaseRow] =
      await Promise.all([
        db.select({ total: count() }).from(schema.organizations).where(isNull(schema.organizations.deletedAt)),

        db.select({ plan: schema.organizations.plan, total: count() })
          .from(schema.organizations)
          .where(isNull(schema.organizations.deletedAt))
          .groupBy(schema.organizations.plan),

        db.select({ total: countDistinct(schema.users.id) }).from(schema.users),

        db.select({ total: count() }).from(schema.jobs),

        db.select({ status: schema.jobs.status, total: count() })
          .from(schema.jobs)
          .groupBy(schema.jobs.status),

        db.select({ type: schema.jobs.type, total: count() })
          .from(schema.jobs)
          .groupBy(schema.jobs.type),

        queueHealth(),

        db.select({ total: count() }).from(schema.vulnerabilities).where(isActiveAdvisory()),

        db.select({ total: count() }).from(schema.vulnerabilities).where(isWithdrawnAdvisory()),

        db.select({ total: count() }).from(schema.vulnerabilities).where(isUnscoredAdvisory()),

        db.select({ level: schema.vulnerabilities.severityLevel, total: count() })
          .from(schema.vulnerabilities)
          .where(isActiveAdvisory())
          .groupBy(schema.vulnerabilities.severityLevel),

        db.select({ total: count() }).from(schema.vulnerabilityAffectedPackages).where(isActiveAffectedPackage()),

        db.select({ total: count() }).from(schema.sboms),

        db.select({ total: count() }).from(schema.components),

        db.select({ total: countDistinct(schema.componentVulnerabilities.componentId) })
          .from(schema.componentVulnerabilities),

        db.select({ total: count() }).from(schema.images),

        // The GC's first condition, without the age one: how many images are
        // unreferenced *now*. Not how many the next sweep will collect —
        // `last_seen_at` has to be older than the retention window for that,
        // and this deliberately counts the ones still inside it too, because
        // that population is the early warning the log line cannot give.
        db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.orphaned),

        db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.awaiting_sbom),

        db.select({ total: count() }).from(schema.clusters),
        db.select({ total: count() }).from(schema.namespaces),
        db.select({ total: count() }).from(schema.workloads),
        db.select({ total: count() }).from(schema.workloadContainers),
        db.select({ total: count() }).from(schema.helmReleases),
      ]);

    const byPlan: Record<string, number> = {};
    for (const row of planRows) {
      byPlan[row.plan] = Number(row.total);
    }

    const byStatus: Record<string, number> = {};
    for (const row of jobStatusRows) {
      byStatus[row.status] = Number(row.total);
    }

    const byType: Record<string, number> = {};
    for (const row of jobTypeRows) {
      byType[row.type] = Number(row.total);
    }

    const bySeverity: Record<string, number> = {};
    for (const row of vulnSeverityRows) {
      bySeverity[row.level ?? "unknown"] = Number(row.total);
    }

    return {
      organizations: {
        total: Number(orgRows[0]?.total ?? 0),
        byPlan,
      },
      users: {
        total: Number(userRow[0]?.total ?? 0),
      },
      jobs: {
        total: Number(jobCountRows[0]?.total ?? 0),
        byStatus,
        byType,
        health: jobHealth,
      },
      vulnerabilities: {
        total: Number(vulnCountRow[0]?.total ?? 0),
        withdrawn: Number(withdrawnVulnRow[0]?.total ?? 0),
        bySeverity,
        withoutCvssScore: Number(unscoredVulnRow[0]?.total ?? 0),
        affectedPackagesTotal: Number(affectedPkgRow[0]?.total ?? 0),
      },
      sboms: {
        total: Number(sbomRow[0]?.total ?? 0),
      },
      components: {
        total: Number(componentRow[0]?.total ?? 0),
        withVulnerabilities: Number(componentVulnRow[0]?.total ?? 0),
      },
      images: {
        total: Number(imageRow[0]?.total ?? 0),
        // `sboms_image_id_unique` makes one SBOM one image, so the SBOM count
        // *is* the count of images carrying one. No second query, and no way
        // for the two figures to disagree.
        withSbom: Number(sbomRow[0]?.total ?? 0),
        orphaned: Number(orphanedImageRow[0]?.total ?? 0),
        awaitingSbom: Number(awaitingSbomImageRow[0]?.total ?? 0),
      },
      kubernetes: {
        clusters: Number(clusterRow[0]?.total ?? 0),
        namespaces: Number(namespaceRow[0]?.total ?? 0),
        workloads: Number(workloadRow[0]?.total ?? 0),
        containers: Number(containerRow[0]?.total ?? 0),
        helmReleases: Number(helmReleaseRow[0]?.total ?? 0),
      },
    };
  },

  async getOsvStatus(): Promise<AdminOsvStatus> {
    const [stateRows, recentRuns, failuresByType, generationRows] =
      await Promise.all([
        db.select().from(schema.osvSyncState).limit(1),
        db.select().from(schema.osvSyncRuns).orderBy(desc(schema.osvSyncRuns.completedAt)).limit(10),
        // One grouped pass rather than a total/recent/by-type trio: the splits
        // below are all derivable from it, and it is the same index scan.
        db.select({
          errorType: schema.osvSyncFailures.errorType,
          total: count(),
          last7Days: sql<string>`count(*) filter (
            where ${schema.osvSyncFailures.occurredAt} > now() - interval '7 days'
          )`,
        })
          .from(schema.osvSyncFailures)
          .groupBy(schema.osvSyncFailures.errorType),
        // Unscoped by generation on purpose — the one query in the codebase that
        // is. Every other reader must call isCurrentGeneration(); this one exists
        // precisely to show what the others are hiding: a rebuild's progress, or
        // rows orphaned by one that died. Grouping on the indexed generation
        // column keeps it to an index-only scan, and this is an admin page.
        db.select({
          generation: schema.vulnerabilityAffectedPackages.generation,
          total: count(),
        })
          .from(schema.vulnerabilityAffectedPackages)
          .groupBy(schema.vulnerabilityAffectedPackages.generation)
          .orderBy(asc(schema.vulnerabilityAffectedPackages.generation)),
      ]);

    const state = stateRows[0] ?? null;

    // `validation_warning` rows describe records that were ingested; every
    // other error type describes one that was not. Splitting on that here is
    // what keeps a schema deviation from reading as a lost advisory.
    const byType: Record<string, number> = {};
    const failed = { total: 0, last7Days: 0 };
    const warned = { total: 0, last7Days: 0 };
    for (const row of failuresByType) {
      const total = Number(row.total);
      const last7Days = Number(row.last7Days);
      const bucket = row.errorType === "validation_warning" ? warned : failed;
      bucket.total += total;
      bucket.last7Days += last7Days;
      if (bucket === failed) byType[row.errorType] = total;
    }

    // Falls back to the column default rather than to "nothing is current" when
    // the state row is missing, matching currentGeneration()'s COALESCE — so a
    // fresh database shows generation 1 as live instead of flagging every row
    // as orphaned.
    const currentGen = state?.affectedPkgGeneration ?? 1;

    return {
      state: state
        ? {
            initialized: state.initialized,
            syncStatus: state.syncStatus,
            lastSuccessfulPollAt: state.lastSuccessfulPollAt,
            lastModifiedSeen: state.lastModifiedSeen,
            lastModifiedApplied: state.lastModifiedApplied,
            lastFullRefreshAt: state.lastFullRefreshAt,
            affectedPkgGeneration: state.affectedPkgGeneration,
            consecutiveFailures: state.consecutiveFailures,
            lastError: state.lastError,
            updatedAt: state.updatedAt,
            ecosystems: state.ecosystems ?? null,
          }
        : null,
      configuredEcosystems: parseEcosystems(process.env[ECOSYSTEMS_ENV_VAR], edition),
      generations: generationRows.map((g) => ({
        generation: g.generation,
        rowCount: Number(g.total),
        isCurrent: g.generation === currentGen,
      })),
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        mode: r.mode,
        success: r.success,
        recordsProcessed: r.recordsProcessed,
        inserted: r.inserted,
        updated: r.updated,
        unchanged: r.unchanged,
        parseFailures: r.parseFailures,
        durationMs: r.durationMs,
        lagSeconds: r.lagSeconds,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      })),
      parseFailures: { ...failed, byType },
      validationWarnings: warned,
    };
  },

  async getFeedsStatus(): Promise<AdminFeedsStatus> {
    const [epssRows, kevRows, ahRows, epssScoredRow, kevListedRow, ahPackagesRow, attributionsRow] =
      await Promise.all([
        db.select().from(schema.epssSyncState).limit(1),
        db.select().from(schema.kevSyncState).limit(1),
        db.select().from(schema.artifactHubSyncState).limit(1),
        db.select({ total: count() }).from(schema.vulnerabilities).where(isNotNull(schema.vulnerabilities.epssScore)),
        db.select({ total: count() }).from(schema.vulnerabilities).where(isNotNull(schema.vulnerabilities.kevListedAt)),
        db.select({ total: count() }).from(schema.artifactHubPackages),
        db.select({ total: count() }).from(schema.chartAttributions),
      ]);

    const epss = epssRows[0] ?? null;
    const kev = kevRows[0] ?? null;
    const ah = ahRows[0] ?? null;

    return {
      staleAfterHours: FEED_STALE_AFTER_HOURS,
      epss: {
        state: epss
          ? {
              lastSyncedAt: epss.lastSyncedAt,
              lastScoreDate: epss.lastScoreDate,
              rowsInFile: epss.rowsInFile,
              rowsMatched: epss.rowsMatched,
              rowsUnmatched: epss.rowsUnmatched,
              lastError: epss.lastError,
              updatedAt: epss.updatedAt,
            }
          : null,
        stale: isFeedStale(epss?.lastSyncedAt),
        advisoriesWithScore: Number(epssScoredRow[0]?.total ?? 0),
      },
      kev: {
        state: kev
          ? {
              lastSyncedAt: kev.lastSyncedAt,
              catalogVersion: kev.catalogVersion,
              releasedAt: kev.releasedAt,
              entriesInCatalog: kev.entriesInCatalog,
              entriesMatched: kev.entriesMatched,
              entriesCleared: kev.entriesCleared,
              lastError: kev.lastError,
              updatedAt: kev.updatedAt,
            }
          : null,
        stale: isFeedStale(kev?.lastSyncedAt),
        advisoriesListed: Number(kevListedRow[0]?.total ?? 0),
      },
      artifactHub: {
        state: ah
          ? {
              lastSyncedAt: ah.lastSyncedAt,
              packagesInDump: ah.packagesInDump,
              packagesApplied: ah.packagesApplied,
              chartsExamined: ah.chartsExamined,
              attributionsWritten: ah.attributionsWritten,
              attributionsRefused: ah.attributionsRefused,
              reposAutoAdded: ah.reposAutoAdded,
              lastError: ah.lastError,
              updatedAt: ah.updatedAt,
            }
          : null,
        stale: isFeedStale(ah?.lastSyncedAt),
        mirrorPackages: Number(ahPackagesRow[0]?.total ?? 0),
        attributions: Number(attributionsRow[0]?.total ?? 0),
      },
    };
  },

  async getRecentOrganizations(limit = 10) {
    return db
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        plan: schema.organizations.plan,
        // Stays in the list — an admin should see it — but badged by the
        // client so its `team` plan with no Stripe customer is not mistaken
        // for a paying account (docs/live-demo/ step 02).
        demo: schema.organizations.demo,
        createdAt: schema.organizations.createdAt,
        memberCount: sql<number>`(
          select count(*) from ${schema.orgMembers}
          where ${schema.orgMembers.orgId} = ${schema.organizations.id}
        )`.as("member_count"),
        sbomCount: sql<number>`(
          select count(distinct s.id) from sboms s
          join workload_containers wc on wc.image_id = s.image_id
          where wc.org_id = organizations.id
        )`.as("sbom_count"),
        clusterCount: sql<number>`(
          select count(*) from clusters c
          where c.org_id = organizations.id
        )`.as("cluster_count"),

      })
      .from(schema.organizations)
      .where(isNull(schema.organizations.deletedAt))
      .orderBy(desc(schema.organizations.createdAt))
      .limit(limit);
  },

  async getOsvState() {
    const [state] = await db.select().from(schema.osvSyncState).limit(1);
    return state ?? null;
  },

  async getVulnerabilityStats() {
    const [totalRow, withdrawnRow, unscoredRow, severityRows, affectedPkgRow] = await Promise.all([
      db.select({ total: count() }).from(schema.vulnerabilities).where(isActiveAdvisory()),
      db.select({ total: count() }).from(schema.vulnerabilities).where(isWithdrawnAdvisory()),
      db.select({ total: count() }).from(schema.vulnerabilities).where(isUnscoredAdvisory()),
      db.select({ level: schema.vulnerabilities.severityLevel, total: count() })
        .from(schema.vulnerabilities)
        .where(isActiveAdvisory())
        .groupBy(schema.vulnerabilities.severityLevel),
      db.select({ total: count() }).from(schema.vulnerabilityAffectedPackages).where(isActiveAffectedPackage()),
    ]);

    const bySeverity: Record<string, number> = {};
    for (const row of severityRows) {
      bySeverity[row.level ?? "unknown"] = Number(row.total);
    }

    return {
      total: Number(totalRow[0]?.total ?? 0),
      withdrawn: Number(withdrawnRow[0]?.total ?? 0),
      bySeverity,
      withoutCvssScore: Number(unscoredRow[0]?.total ?? 0),
      affectedPackagesTotal: Number(affectedPkgRow[0]?.total ?? 0),
    };
  },

  /**
   * The three numbers `vulnerabilities.withdrawn_at` is actually worth
   * rendering. A raw count of retracted advisories is trivia; what matters is
   * whether the retraction reached the customer's findings (`staleFindings`)
   * and whether the denormalised copy of the flag agrees with it
   * (`denormalizationDrift`). See AdminWithdrawnStats for why each is here.
   */
  async getWithdrawnStats(): Promise<AdminWithdrawnStats> {
    const [advisoryRow, staleRow, driftRow] = await Promise.all([
      db.select({ total: count() }).from(schema.vulnerabilities).where(isWithdrawnAdvisory()),

      db
        .select({
          links: count(),
          components: countDistinct(schema.componentVulnerabilities.componentId),
          advisories: countDistinct(schema.componentVulnerabilities.vulnerabilityId),
        })
        .from(schema.componentVulnerabilities)
        .innerJoin(
          schema.vulnerabilities,
          eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id),
        )
        .where(isWithdrawnAdvisory()),

      // Only the false-negative direction (advisory withdrawn, flag still
      // false) is checked. That is the one that costs something: it leaves rows
      // inside the matcher's partial index. The reverse — flag true, advisory
      // live — would need a scan of every `withdrawn = true` row, which no index
      // covers precisely because those rows are excluded from the one that
      // matters, and it fails safe anyway (a candidate withheld, not served).
      db
        .select({ total: count() })
        .from(schema.vulnerabilityAffectedPackages)
        .innerJoin(
          schema.vulnerabilities,
          eq(schema.vulnerabilityAffectedPackages.vulnerabilityId, schema.vulnerabilities.id),
        )
        .where(
          and(
            isWithdrawnAdvisory(),
            eq(schema.vulnerabilityAffectedPackages.withdrawn, false),
            isCurrentGeneration(),
          ),
        ),
    ]);

    return {
      advisories: Number(advisoryRow[0]?.total ?? 0),
      staleFindings: {
        links: Number(staleRow[0]?.links ?? 0),
        components: Number(staleRow[0]?.components ?? 0),
        advisories: Number(staleRow[0]?.advisories ?? 0),
      },
      denormalizationDrift: Number(driftRow[0]?.total ?? 0),
    };
  },

  /**
   * The aggregate view of what the matcher has been doing.
   *
   * Every column here is already written on every link and already rendered per
   * component by the Explorer — but one match at a time cannot show a
   * regression. A rewrite that quietly demotes half the npm matches from `exact`
   * to `fuzzy` is four indistinguishable component pages and one obvious bar.
   * See `server/docs/matcher-post-rewrite-gaps.md`.
   *
   * Two queries, not five. The three distributions come from one grouped scan of
   * the whole cube (3 × 4 × 4 possible combinations, so the grouping is free)
   * and are folded apart here; splitting them into three queries would scan
   * `component_vulnerabilities` three times for the same rows.
   */
  async getMatcherQuality(disagreementLimit = 12): Promise<AdminMatcherQuality> {
    // Family, not the whole ecosystem string: 'Alpine:v3.23' and 'Alpine:v3.19'
    // are the same answer to "what kind of package is this", and grouping on the
    // raw string would spread one finding across every distro release.
    const family = sql<string | null>`nullif(split_part(${schema.componentVulnerabilities.matchedEcosystem}, ':', 1), '')`;
    // The PURL type is everything between 'pkg:' and the first '/'. A PURL that
    // does not start that way (including the legacy 'pkg://' form) yields null
    // and lands in `unresolvable` rather than being guessed at.
    const componentPurlType = sql<string | null>`lower(substring(${schema.components.purl} from '^pkg:([^/]+)'))`;

    const [cubeRows, pairRows] = await Promise.all([
      db
        .select({
          matchType: schema.componentVulnerabilities.matchType,
          matchConfidence: schema.componentVulnerabilities.matchConfidence,
          matchedBy: schema.componentVulnerabilities.matchedBy,
          total: count(),
        })
        .from(schema.componentVulnerabilities)
        .groupBy(
          schema.componentVulnerabilities.matchType,
          schema.componentVulnerabilities.matchConfidence,
          schema.componentVulnerabilities.matchedBy,
        ),

      db
        .select({
          family: family.as("family"),
          componentPurlType: componentPurlType.as("component_purl_type"),
          total: count(),
        })
        .from(schema.componentVulnerabilities)
        .innerJoin(schema.components, eq(schema.componentVulnerabilities.componentId, schema.components.id))
        .groupBy(family, componentPurlType),
    ]);

    const byMatchType: Record<string, number> = {};
    const byMatchConfidence: Record<string, number> = {};
    const byMatchedBy: Record<string, number> = {};
    let total = 0;

    for (const row of cubeRows) {
      const n = Number(row.total);
      total += n;
      const add = (target: Record<string, number>, key: string | null) => {
        const k = key ?? UNRECORDED;
        target[k] = (target[k] ?? 0) + n;
      };
      add(byMatchType, row.matchType);
      add(byMatchConfidence, row.matchConfidence);
      add(byMatchedBy, row.matchedBy);
    }

    let agreeing = 0;
    let disagreeing = 0;
    let unrecorded = 0;
    let unresolvable = 0;
    const topDisagreements: AdminEcosystemDisagreement[] = [];

    for (const row of pairRows) {
      const n = Number(row.total);

      if (row.family === null) {
        unrecorded += n;
        continue;
      }

      // The mapping lives in matching/ecosystem.ts and is resolved here rather
      // than in SQL so the table stays the single place a family is defined —
      // a VALUES list in this query would be a second copy that drifts silently.
      const expectedPurlType = purlTypeForFamily(row.family);
      if (!expectedPurlType || !row.componentPurlType) {
        unresolvable += n;
        continue;
      }

      if (expectedPurlType === row.componentPurlType) {
        agreeing += n;
      } else {
        disagreeing += n;
        topDisagreements.push({
          family: row.family,
          expectedPurlType,
          componentPurlType: row.componentPurlType,
          count: n,
        });
      }
    }

    topDisagreements.sort((a, b) => b.count - a.count);

    return {
      total,
      byMatchType,
      byMatchConfidence,
      byMatchedBy,
      ecosystemAgreement: {
        agreeing,
        disagreeing,
        unrecorded,
        unresolvable,
        // Capped for the table below it, not for the counts above — `disagreeing`
        // is the full figure, so a long tail is still visible as the gap between
        // it and the rows shown.
        topDisagreements: topDisagreements.slice(0, disagreementLimit),
      },
    };
  },

  async getAdvisoryIdDistribution(limit = 20): Promise<AdminEcosystemEntry[]> {
    const rows = await db
      .select({
        ecosystem: schema.vulnerabilities.idPrefix,
        total: count(),
      })
      .from(schema.vulnerabilities)
      .where(isActiveAdvisory())
      .groupBy(schema.vulnerabilities.idPrefix)
      .orderBy(desc(count()))
      .limit(limit);

    return rows.map((r) => ({
      ecosystem: r.ecosystem || "unknown",
      count: Number(r.total),
    }));
  },

  async getEcosystemDistribution(limit = 15): Promise<AdminEcosystemEntry[]> {
    const normalizedEcosystem = sql<string>`SPLIT_PART(${schema.vulnerabilityAffectedPackages.ecosystem}, ':', 1)`;
    const rows = await db
      .select({
        ecosystem: normalizedEcosystem.as("ecosystem"),
        total: count(),
      })
      .from(schema.vulnerabilityAffectedPackages)
      .where(isActiveAffectedPackage())
      .groupBy(normalizedEcosystem)
      .orderBy(desc(count()))
      .limit(limit);

    return rows.map((r) => ({
      ecosystem: r.ecosystem || "unknown",
      count: Number(r.total),
    }));
  },

  async listParseFailures(limit: number, offset: number) {
    return db
      .select({
        id: schema.osvSyncFailures.id,
        syncRunId: schema.osvSyncFailures.syncRunId,
        syncMode: schema.osvSyncFailures.syncMode,
        osvId: schema.osvSyncFailures.osvId,
        ecosystemDir: schema.osvSyncFailures.ecosystemDir,
        sourcePath: schema.osvSyncFailures.sourcePath,
        errorType: schema.osvSyncFailures.errorType,
        occurredAt: schema.osvSyncFailures.occurredAt,
      })
      .from(schema.osvSyncFailures)
      .orderBy(desc(schema.osvSyncFailures.occurredAt))
      .limit(limit)
      .offset(offset);
  },

  async countParseFailures(): Promise<number> {
    const [row] = await db.select({ total: count() }).from(schema.osvSyncFailures);
    return Number(row?.total ?? 0);
  },

  async getParseFailureById(id: number) {
    const [row] = await db
      .select()
      .from(schema.osvSyncFailures)
      .where(eq(schema.osvSyncFailures.id, id));
    return row ?? null;
  },

  async deleteAllParseFailures(): Promise<number> {
    const result = await db.delete(schema.osvSyncFailures);
    return result.length ?? 0;
  },

  async getAdminJobs(options?: {
    status?: string[];
    limit?: number;
    offset?: number;
  }) {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    // One predicate, both queries. `total` drives the client's page count, so a
    // count that ignores the status filter reports pages of rows the filtered
    // query will never return — "Page 1 of 100" over three failed jobs.
    const statusFilter = options?.status?.length
      ? inArray(schema.jobs.status, options.status as JobStatus[])
      : undefined;

    let query = db
      .select({
        id: schema.jobs.id,
        orgId: schema.jobs.orgId,
        orgName: schema.organizations.name,
        orgSlug: schema.organizations.slug,
        imageId: schema.jobs.imageId,
        type: schema.jobs.type,
        status: schema.jobs.status,
        priority: schema.jobs.priority,
        title: schema.jobs.title,
        triggeredBy: schema.jobs.triggeredBy,
        scheduledFor: schema.jobs.scheduledFor,
        startedAt: schema.jobs.startedAt,
        completedAt: schema.jobs.completedAt,
        progress: schema.jobs.progress,
        progressMessage: schema.jobs.progressMessage,
        errorCode: schema.jobs.errorCode,
        errorMessage: schema.jobs.errorMessage,
        retryCount: schema.jobs.retryCount,
        maxRetries: schema.jobs.maxRetries,
        createdAt: schema.jobs.createdAt,
      })
      .from(schema.jobs)
      .innerJoin(schema.organizations, eq(schema.jobs.orgId, schema.organizations.id))
      .$dynamic();

    if (statusFilter) {
      query = query.where(statusFilter);
    }

    // The count omits the organizations join the row query carries: `jobs.org_id`
    // is NOT NULL with an FK, so the inner join never drops a row, and the join
    // would only cost the count a scan it does not need.
    let countQuery = db.select({ total: count() }).from(schema.jobs).$dynamic();
    if (statusFilter) {
      countQuery = countQuery.where(statusFilter);
    }

    const [rows, totalRow] = await Promise.all([
      query
        .orderBy(desc(schema.jobs.createdAt))
        .limit(limit)
        .offset(offset),
      countQuery,
    ]);

    return {
      jobs: rows,
      total: Number(totalRow[0]?.total ?? 0),
      limit,
      offset,
    };
  },

  // ── Images ─────────────────────────────────────────────────────────────────

  /**
   * Every image in the database, whoever runs it and whether or not it has been
   * scanned.
   *
   * The Explorer's image list answers a different question and cannot answer
   * this one: it starts `FROM sboms` and filters by `deployedImages(orgId)`, so
   * an image is invisible there unless it has an SBOM *and* a container in the
   * selected org. That hides exactly the rows an operator needs — the ingest
   * backlog (discovered, unscanned) and the GC's queue (referenced by nothing).
   * This starts `FROM images` and left-joins everything else, so those rows
   * survive.
   *
   * Counts come from grouped queries keyed on the page's ids rather than
   * correlated subqueries: a correlated subquery over `images` renders the
   * outer column unqualified and silently matches the inner table instead.
   */
  async listAdminImages(options: {
    limit: number;
    offset: number;
    state?: AdminImageState;
    search?: string;
    sort?: AdminImageSort;
  }): Promise<AdminImagesPage> {
    const limit = Math.min(Math.max(options.limit, 1), 200);
    const offset = Math.max(options.offset, 0);

    const filters: SQL[] = [];
    if (options.state) filters.push(IMAGE_STATE_FILTERS[options.state]);
    if (options.search) {
      const term = `%${options.search}%`;
      filters.push(
        or(
          ilike(schema.images.digest, term),
          ilike(schema.images.repository, term),
          ilike(schema.images.registry, term)
        )!
      );
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const orderBy = {
      lastSeen: [desc(schema.images.lastSeenAt)],
      firstSeen: [desc(schema.images.firstSeenAt)],
      // Digest as the tie-break: repository is nullable and far from unique, and
      // an unstable order across pages shows rows twice and skips others.
      repository: [asc(schema.images.repository), asc(schema.images.digest)],
    }[options.sort ?? "lastSeen"];

    const [rows, [totalRow], orphanedTotal, awaitingTotal, scannedTotal] = await Promise.all([
      db.select({
        id: schema.images.id,
        digest: schema.images.digest,
        registry: schema.images.registry,
        repository: schema.images.repository,
        firstSeenAt: schema.images.firstSeenAt,
        lastSeenAt: schema.images.lastSeenAt,
        // For the GC countdown: the window depends on the owning org's plan.
        plan: schema.organizations.plan,
      })
        .from(schema.images)
        .innerJoin(schema.organizations, eq(schema.images.orgId, schema.organizations.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(schema.images).where(where),
      // Unfiltered on purpose: these label the filter control, so they must not
      // change when the filter does.
      db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.orphaned),
      db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.awaiting_sbom),
      db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.scanned),
    ]);

    const stateTotals: Record<AdminImageState, number> = {
      orphaned: Number(orphanedTotal[0]?.total ?? 0),
      awaiting_sbom: Number(awaitingTotal[0]?.total ?? 0),
      scanned: Number(scannedTotal[0]?.total ?? 0),
    };

    const page: AdminImagesPage = {
      images: [],
      total: Number(totalRow?.total ?? 0),
      limit,
      offset,
      stateTotals,
      retentionDays: IMAGE_GC_RETENTION_DAYS,
    };
    if (rows.length === 0) return page;

    const imageIds = rows.map((r) => r.id);

    const [sbomRows, usageRows, findingRows] = await Promise.all([
      db.select({
        id: schema.sboms.id,
        imageId: schema.sboms.imageId,
        format: schema.sboms.format,
        createdAt: schema.sboms.createdAt,
      })
        .from(schema.sboms)
        .where(inArray(schema.sboms.imageId, imageIds)),

      // One pass for all three usage figures. The joins up to `namespaces` do
      // not change `count(*)` — `workload_id` and `namespace_id` are both
      // `notNull` FKs, so a container has exactly one workload and a workload
      // exactly one namespace — which is also what lets `state` below be
      // derived from `containerCount` and still agree with the SQL predicate
      // the filter uses. Make either column nullable and the two drift.
      db.select({
        imageId: schema.workloadContainers.imageId,
        containerCount: count(),
        orgCount: countDistinct(schema.workloadContainers.orgId),
        clusterCount: countDistinct(schema.namespaces.clusterId),
      })
        .from(schema.workloadContainers)
        .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
        .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
        .where(inArray(schema.workloadContainers.imageId, imageIds))
        .groupBy(schema.workloadContainers.imageId),

      // `severityRowsByImage` (over `collapsedFindings`) and nothing else —
      // this column has to agree with the number the customer sees for the
      // same digest, so the three rules in `db/findings.ts` apply here exactly
      // as they do everywhere. Only the bucketing differs: the local
      // `addSeverity` keeps an `unknown` bucket that the customer-facing
      // surfaces fold away, and on an admin screen "we could not rank 40 of
      // these" is the finding.
      severityRowsByImage(imageIds),
    ]);

    const sbomByImage = new Map(sbomRows.map((r) => [r.imageId, r]));
    const usageByImage = new Map(usageRows.map((r) => [r.imageId, r]));

    const findingsByImage = new Map<string, SeverityCounts>();
    for (const row of findingRows) {
      let counts = findingsByImage.get(row.imageId);
      if (!counts) { counts = EMPTY_SEVERITY(); findingsByImage.set(row.imageId, counts); }
      addSeverity(counts, row.severityLevel, Number(row.count));
    }

    const [componentCounts, scanned] = await Promise.all([
      componentCountsBySbom(sbomRows.map((r) => r.id)),
      scannedImageIds(new Map(sbomRows.map((r) => [r.imageId, r.id]))),
    ]);

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1_000;

    page.images = rows.map((r) => {
      const sbom = sbomByImage.get(r.id);
      const usage = usageByImage.get(r.id);
      const containerCount = Number(usage?.containerCount ?? 0);
      const state: AdminImageState =
        containerCount === 0 ? "orphaned" : sbom ? "scanned" : "awaiting_sbom";

      return {
        id: r.id,
        digest: r.digest,
        registry: r.registry,
        repository: r.repository,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        sbomId: sbom?.id ?? null,
        sbomFormat: sbom?.format ?? null,
        sbomCreatedAt: sbom?.createdAt ?? null,
        componentCount: sbom ? componentCounts.get(sbom.id) ?? 0 : 0,
        findings: scanned.has(r.id) ? findingsByImage.get(r.id) ?? EMPTY_SEVERITY() : null,
        containerCount,
        orgCount: Number(usage?.orgCount ?? 0),
        clusterCount: Number(usage?.clusterCount ?? 0),
        state,
        gcInDays:
          state === "orphaned"
            ? Math.ceil(imageGcRetentionDays(r.plan) - (now - r.lastSeenAt.getTime()) / DAY_MS)
            : null,
      };
    });

    return page;
  },

  // ── SBOM Explorer ──────────────────────────────────────────────────────────

  /**
   * Images the org is running that have an SBOM, with component + vuln counts.
   *
   * The explorer's first level used to be projects, which meant the same base
   * image appeared once per workload that ran it. One row per image is both
   * shorter and the level a remediation acts on.
   */
  async listExplorerImages(orgId: string): Promise<ExplorerImage[]> {
    const sbomRows = await db
      .select({
        imageId: schema.images.id,
        digest: schema.images.digest,
        registry: schema.images.registry,
        repository: schema.images.repository,
        sbomId: schema.sboms.id,
        format: schema.sboms.format,
        generatedAt: schema.sboms.generatedAt,
        createdAt: schema.sboms.createdAt,
      })
      .from(schema.sboms)
      .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
      .where(deployedImages(orgId))
      .orderBy(asc(schema.images.repository), asc(schema.images.digest));

    if (sbomRows.length === 0) return [];

    // Counts via grouped queries (correlated subqueries render the outer column
    // unqualified and silently match the wrong table — see grouped helpers).
    const [componentCounts, deploymentCounts, bySbom] = await Promise.all([
      componentCountsBySbom(sbomRows.map((r) => r.sbomId)),
      deploymentCountsByImage(sbomRows.map((r) => r.imageId)),
      severityCountsBySbom(sbomRows.map((r) => r.sbomId)),
    ]);

    return sbomRows.map((r) => ({
      imageId: r.imageId,
      digest: r.digest,
      registry: r.registry,
      repository: r.repository,
      sbomId: r.sbomId,
      format: r.format,
      generatedAt: r.generatedAt,
      createdAt: r.createdAt,
      deploymentCount: deploymentCounts.get(r.imageId) ?? 0,
      componentCount: componentCounts.get(r.sbomId) ?? 0,
      vulnCounts: bySbom.get(r.sbomId) ?? EMPTY_SEVERITY(),
    }));
  },

  /**
   * The SBOM for an image, with component + vuln counts.
   *
   * Returns an array of at most one element: `sboms_image_id_unique` makes an
   * image's SBOM singular. Kept as a list because the explorer renders it as a
   * drill-down level and an empty result is a meaningful state — an image
   * discovered but not yet scanned.
   */
  async listExplorerSboms(imageId: string): Promise<ExplorerSbom[]> {
    const sbomRows = await db
      .select({
        id: schema.sboms.id,
        format: schema.sboms.format,
        specVersion: schema.sboms.specVersion,
        sourceName: schema.sboms.sourceName,
        digest: schema.images.digest,
        toolName: schema.sboms.toolName,
        toolVersion: schema.sboms.toolVersion,
        generatedAt: schema.sboms.generatedAt,
        createdAt: schema.sboms.createdAt,
      })
      .from(schema.sboms)
      .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
      .where(eq(schema.sboms.imageId, imageId))
      .orderBy(desc(schema.sboms.createdAt));

    if (sbomRows.length === 0) return [];

    const sbomIds = sbomRows.map((r) => r.id);
    const [componentCounts, bySbom] = await Promise.all([
      componentCountsBySbom(sbomIds),
      severityCountsBySbom(sbomIds),
    ]);

    return sbomRows.map((r) => ({
      id: r.id,
      format: r.format,
      specVersion: r.specVersion,
      sourceName: r.sourceName,
      digest: r.digest,
      toolName: r.toolName,
      toolVersion: r.toolVersion,
      generatedAt: r.generatedAt,
      createdAt: r.createdAt,
      componentCount: componentCounts.get(r.id) ?? 0,
      vulnCounts: bySbom.get(r.id) ?? EMPTY_SEVERITY(),
    }));
  },

  /** Paginated components of an SBOM, each with its vulnerability severity counts. */
  async listExplorerComponents(
    sbomId: string,
    options: { search?: string; limit?: number; offset?: number } = {},
  ): Promise<ExplorerComponentsPage> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const search = options.search?.trim();
    const where = search
      ? and(
          eq(schema.components.sbomId, sbomId),
          or(ilike(schema.components.name, `%${search}%`), ilike(schema.components.purl, `%${search}%`)),
        )
      : eq(schema.components.sbomId, sbomId);

    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: schema.components.id,
          name: schema.components.name,
          version: schema.components.version,
          type: schema.components.type,
          purl: schema.components.purl,
          groupName: schema.components.groupName,
          isDirect: schema.components.isDirect,
          scope: schema.components.scope,
        })
        .from(schema.components)
        .where(where)
        .orderBy(asc(schema.components.name), asc(schema.components.version))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(schema.components).where(where),
    ]);

    const byComponent = new Map<string, SeverityCounts>();
    if (rows.length > 0) {
      const componentIds = rows.map((r) => r.id);
      const severityRows = await db
        .select({
          componentId: schema.componentVulnerabilities.componentId,
          level: schema.vulnerabilities.severityLevel,
          total: count(),
        })
        .from(schema.componentVulnerabilities)
        .innerJoin(schema.vulnerabilities, eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id))
        .where(inArray(schema.componentVulnerabilities.componentId, componentIds))
        .groupBy(schema.componentVulnerabilities.componentId, schema.vulnerabilities.severityLevel);

      for (const row of severityRows) {
        let counts = byComponent.get(row.componentId);
        if (!counts) { counts = EMPTY_SEVERITY(); byComponent.set(row.componentId, counts); }
        addSeverity(counts, row.level, Number(row.total));
      }
    }

    return {
      components: rows.map((r) => ({
        ...r,
        vulnCounts: byComponent.get(r.id) ?? EMPTY_SEVERITY(),
      })),
      total: Number(totalRow[0]?.total ?? 0),
      limit,
      offset,
    };
  },

  /** A single component with its matched vulnerabilities and their affected packages. */
  async getExplorerComponentDetail(componentId: string): Promise<ExplorerComponentDetail | null> {
    const [component] = await db
      .select({
        id: schema.components.id,
        name: schema.components.name,
        version: schema.components.version,
        type: schema.components.type,
        purl: schema.components.purl,
        cpe: schema.components.cpe,
        groupName: schema.components.groupName,
        isDirect: schema.components.isDirect,
        scope: schema.components.scope,
      })
      .from(schema.components)
      .where(eq(schema.components.id, componentId));

    if (!component) return null;

    const vulnRows = await db
      .select({
        id: schema.vulnerabilities.id,
        vulnId: schema.vulnerabilities.vulnId,
        summary: schema.vulnerabilities.summary,
        details: schema.vulnerabilities.details,
        severityLevel: schema.vulnerabilities.severityLevel,
        cvssScore: schema.vulnerabilities.cvssScore,
        aliases: schema.vulnerabilities.aliases,
        references: schema.vulnerabilities.references,
        publishedAt: schema.vulnerabilities.publishedAt,
        modifiedAt: schema.vulnerabilities.modifiedAt,
        matchedBy: schema.componentVulnerabilities.matchedBy,
        matchConfidence: schema.componentVulnerabilities.matchConfidence,
        matchType: schema.componentVulnerabilities.matchType,
        matchedEcosystem: schema.componentVulnerabilities.matchedEcosystem,
        matchedFixedVersion: schema.componentVulnerabilities.fixedVersion,
        upstreamName: schema.componentVulnerabilities.upstreamName,
        upstreamVersion: schema.componentVulnerabilities.upstreamVersion,
      })
      .from(schema.componentVulnerabilities)
      .innerJoin(schema.vulnerabilities, eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id))
      .where(eq(schema.componentVulnerabilities.componentId, componentId))
      .orderBy(desc(schema.vulnerabilities.cvssScore));

    const byVuln = new Map<string, ExplorerAffectedPackage[]>();
    if (vulnRows.length > 0) {
      const vulnIds = vulnRows.map((v) => v.id);
      const affectedRows = await db
        .select({
          vulnerabilityId: schema.vulnerabilityAffectedPackages.vulnerabilityId,
          ecosystem: schema.vulnerabilityAffectedPackages.ecosystem,
          packageName: schema.vulnerabilityAffectedPackages.packageName,
          purl: schema.vulnerabilityAffectedPackages.purl,
          versions: schema.vulnerabilityAffectedPackages.versions,
          ranges: schema.vulnerabilityAffectedPackages.ranges,
          fixedVersion: schema.vulnerabilityAffectedPackages.fixedVersion,
        })
        .from(schema.vulnerabilityAffectedPackages)
        .where(
          and(
            inArray(schema.vulnerabilityAffectedPackages.vulnerabilityId, vulnIds),
            isCurrentGeneration()
          )
        );

      for (const row of affectedRows) {
        let list = byVuln.get(row.vulnerabilityId);
        if (!list) { list = []; byVuln.set(row.vulnerabilityId, list); }
        list.push({
          ecosystem: row.ecosystem,
          packageName: row.packageName,
          purl: row.purl,
          versions: row.versions ?? [],
          ranges: row.ranges ?? [],
          fixedVersion: row.fixedVersion,
        });
      }
    }

    return {
      component,
      vulnerabilities: vulnRows.map((v) => ({
        id: v.id,
        vulnId: v.vulnId,
        summary: v.summary,
        details: v.details,
        severityLevel: v.severityLevel,
        cvssScore: v.cvssScore,
        aliases: v.aliases ?? [],
        references: v.references ?? [],
        publishedAt: v.publishedAt,
        modifiedAt: v.modifiedAt,
        matchedBy: v.matchedBy,
        matchConfidence: v.matchConfidence,
        matchType: v.matchType,
        matchedEcosystem: v.matchedEcosystem,
        matchedFixedVersion: v.matchedFixedVersion,
        upstreamName: v.upstreamName,
        upstreamVersion: v.upstreamVersion,
        affectedPackages: byVuln.get(v.id) ?? [],
      })),
    };
  },
};
