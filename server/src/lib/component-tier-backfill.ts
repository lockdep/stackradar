/**
 * The re-classification loop over `components.tier`: rows below
 * `TIER_VERSION`, or an org's rows after one of its tier rules changed
 * (`tier-rules.service.ts`). Takes any connection so an integration test can
 * drive it without the worker.
 */

import type postgres from "postgres";
import {
    applyTierRules,
    classifyComponent,
    TIER_PROPERTY_NAMES,
    TIER_VERSION,
    type Tier,
    type TierRule,
} from "./component-tier.js";
import { detectMainComponent } from "./main-component.js";

const BATCH_SIZE = 5_000;

interface Row {
    id: string;
    name: string;
    type: string;
    purl: string | null;
    org_id: string;
    package_type: string | null;
    path: string | null;
    main_module: string | null;
}

export interface TierBackfillResult {
    components: number;
    histogram: Record<Tier, number>;
    /**
     * `unknown` among rows that are packages at all. syft's `file` entries and
     * the distro component carry no package type by construction, so counting
     * them would drown the number this exists to watch.
     */
    unknownShareOfPackages: number;
    /** Rows the per-image pass moved: the one `main` an image's ENTRYPOINT names, and the mains it demoted. */
    mainNarrowed: number;
}

export interface TierBackfillOptions {
    dryRun?: boolean;
    onProgress?: (seen: number) => void;
    /**
     * Reclassify every component of this org, whatever its `tier_version` —
     * what runs after the org's tier rules change. Without it the pass is the
     * global one: rows below `TIER_VERSION` only.
     */
    orgId?: string;
}

/** Every org's override rules, keyed by org — read once per pass; there are few. */
async function loadRules(sql: postgres.Sql, orgId?: string): Promise<Map<string, TierRule[]>> {
    const rows = await sql<
        { org_id: string; match_kind: TierRule["matchKind"]; pattern: string; tier: TierRule["tier"] }[]
    >`
        SELECT org_id, match_kind, pattern, tier
          FROM component_tier_rules
         ${orgId ? sql`WHERE org_id = ${orgId}` : sql``}
    `;
    const byOrg = new Map<string, TierRule[]>();
    for (const r of rows) {
        const list = byOrg.get(r.org_id) ?? [];
        list.push({ matchKind: r.match_kind, pattern: r.pattern, tier: r.tier });
        byOrg.set(r.org_id, list);
    }
    return byOrg;
}

export async function backfillComponentTier(
    sql: postgres.Sql,
    options: TierBackfillOptions = {},
): Promise<TierBackfillResult> {
    const rulesByOrg = await loadRules(sql, options.orgId);
    const histogram: Record<Tier, number> = { os: 0, runtime: 0, application: 0, main: 0, unknown: 0 };
    let unknownPackages = 0;
    let packages = 0;
    let seen = 0;
    let cursor = "00000000-0000-0000-0000-000000000000";

    for (;;) {
        const rows = await sql<Row[]>`
            SELECT c.id, c.name, c.type, c.purl, c.org_id,
                   max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[0]}) AS package_type,
                   max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[1]}) AS path,
                   max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[2]}) AS main_module
              FROM (
                    SELECT co.id, co.name, co.type, co.purl, i.org_id
                      FROM components co
                      JOIN sboms s ON s.id = co.sbom_id
                      JOIN images i ON i.id = s.image_id
                     WHERE co.id > ${cursor}::uuid
                       AND ${options.orgId ? sql`i.org_id = ${options.orgId}` : sql`co.tier_version < ${TIER_VERSION}`}
                     ORDER BY co.id
                     LIMIT ${BATCH_SIZE}
                   ) c
              LEFT JOIN component_properties p
                     ON p.component_id = c.id AND p.name IN ${sql([...TIER_PROPERTY_NAMES])}
             GROUP BY c.id, c.name, c.type, c.purl, c.org_id
             ORDER BY c.id
        `;
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]!.id;

        const values: [string, string][] = [];
        for (const row of rows) {
            const builtin = classifyComponent({
                packageType: row.package_type,
                name: row.name,
                path: row.path,
                mainModule: row.main_module,
            });
            // The org's own rules speak last — as they do at ingest.
            const tier = applyTierRules(
                builtin,
                { name: row.name, purl: row.purl, path: row.path },
                rulesByOrg.get(row.org_id) ?? [],
            );
            histogram[tier] += 1;
            if (row.type !== "file" && row.type !== "operating-system") {
                packages += 1;
                if (tier === "unknown") unknownPackages += 1;
            }
            values.push([row.id, tier]);
        }
        seen += rows.length;

        if (!options.dryRun) {
            await sql`
                UPDATE components AS c
                   SET tier = v.tier, tier_version = ${TIER_VERSION}
                  FROM (values ${sql(values)}) AS v(id, tier)
                 WHERE c.id = v.id::uuid
            `;
        }
        options.onProgress?.(seen);
    }

    const narrowed = options.dryRun ? 0 : await narrowMainTiers(sql, rulesByOrg, options.orgId);

    if (!options.dryRun && seen > 0) await sql`ANALYZE components`;
    return {
        components: seen,
        histogram,
        unknownShareOfPackages: packages === 0 ? 0 : Number((unknownPackages / packages).toFixed(4)),
        mainNarrowed: narrowed,
    };
}

interface CandidateRow {
    id: string;
    image_id: string;
    org_id: string;
    name: string;
    purl: string | null;
    entrypoint: string | null;
    cmd: string | null;
    package_type: string | null;
    path: string | null;
    main_module: string | null;
}

/**
 * The per-image half of the classifier (`lib/main-component.ts`): where an
 * image's ENTRYPOINT / CMD names its application, `main` is that component
 * alone. The pass above is per component and cannot see that, so it runs
 * after it — over the few rows per image that can be `main` at all (a Go main
 * module, a fingerprinted executable), and only for images whose scanner sent
 * the facts. Org rules still speak last.
 */
async function narrowMainTiers(
    sql: postgres.Sql,
    rulesByOrg: ReadonlyMap<string, TierRule[]>,
    orgId: string | undefined,
): Promise<number> {
    const rows = await sql<CandidateRow[]>`
        SELECT co.id, i.id AS image_id, i.org_id, co.name, co.purl,
               i.metadata->>'entrypoint' AS entrypoint,
               i.metadata->>'cmd' AS cmd,
               max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[0]}) AS package_type,
               max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[1]}) AS path,
               max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[2]}) AS main_module
          FROM images i
          JOIN sboms s ON s.image_id = i.id
          JOIN components co ON co.sbom_id = s.id
          JOIN component_properties p ON p.component_id = co.id AND p.name IN ${sql([...TIER_PROPERTY_NAMES])}
         WHERE (i.metadata ? 'entrypoint' OR i.metadata ? 'cmd')
           AND ${orgId ? sql`i.org_id = ${orgId}` : sql`true`}
         GROUP BY co.id, i.id, i.org_id, co.name, co.purl, i.metadata
        HAVING max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[0]}) = 'binary'
            OR max(p.value) FILTER (WHERE p.name = ${TIER_PROPERTY_NAMES[2]}) = co.name
    `;

    const byImage = new Map<string, CandidateRow[]>();
    for (const row of rows) byImage.set(row.image_id, [...(byImage.get(row.image_id) ?? []), row]);

    const values: [string, string][] = [];
    for (const candidates of byImage.values()) {
        const first = candidates[0]!;
        const verdict = detectMainComponent(
            { entrypoint: first.entrypoint, cmd: first.cmd },
            candidates.map((c) => ({
                id: c.id,
                name: c.name,
                packageType: c.package_type,
                path: c.path,
                mainModule: c.main_module,
            })),
        );
        if (verdict.componentId === null) continue;
        for (const c of candidates) {
            const builtin = classifyComponent({
                packageType: c.package_type,
                name: c.name,
                path: c.path,
                mainModule: c.main_module,
            });
            const tier: Tier = c.id === verdict.componentId ? "main" : builtin === "main" ? "application" : builtin;
            if (tier === builtin) continue;
            values.push([
                c.id,
                applyTierRules(tier, { name: c.name, purl: c.purl, path: c.path }, rulesByOrg.get(c.org_id) ?? []),
            ]);
        }
    }

    for (let i = 0; i < values.length; i += BATCH_SIZE) {
        await sql`
            UPDATE components AS c
               SET tier = v.tier
              FROM (values ${sql(values.slice(i, i + BATCH_SIZE))}) AS v(id, tier)
             WHERE c.id = v.id::uuid
        `;
    }
    return values.length;
}
