-- Backfill `vulnerabilities.finding_identity` now that the identity also reads
-- OSV `upstream` (`lib/vulnerability-aliases.ts#findingIdentityOf`).
--
-- A distro tracker entry — `UBUNTU-CVE-2026-4046` and its Debian / Rocky
-- equivalents — names the CVE it tracks under `upstream`, never `aliases`, so
-- every one of them was stored as a stand-alone `#UBUNTU-CVE-…` identity and
-- never collapsed with the CVE it plainly is. The same single-CVE rule applies
-- to `upstream` as to `aliases`: a notice listing several CVEs there keeps the
-- stand-alone form.
--
-- `upstream` is not a column; it lives in `raw_data`, which is why the sync
-- reads it from the raw record too. Only rows that carry the field can change,
-- and a `CVE-` record's identity is its own id whatever it lists, so the
-- statement is scoped to non-CVE rows carrying the field. That is still a
-- sequential scan over `raw_data` (~900k rows, a few minutes on the managed
-- database) — a one-off catch-up, not a rule the schema depends on: the OSV
-- sync rewrites the column on every advisory change.
UPDATE "vulnerabilities" AS v
SET "finding_identity" = d.identity
FROM (
    SELECT
        id,
        CASE
            WHEN vuln_id ~* '^CVE-[0-9]{4}-[0-9]{4,}$' THEN upper(vuln_id)
            ELSE coalesce(
                (
                    SELECT CASE WHEN count(DISTINCT upper(ref)) = 1 THEN min(upper(ref)) END
                    FROM jsonb_array_elements_text(
                        coalesce(aliases, '[]'::jsonb)
                        || CASE WHEN jsonb_typeof(raw_data -> 'upstream') = 'array'
                                THEN raw_data -> 'upstream'
                                ELSE '[]'::jsonb
                           END
                    ) AS t(ref)
                    WHERE ref ~* '^CVE-[0-9]{4}-[0-9]{4,}$'
                ),
                '#' || vuln_id
            )
        END AS identity
    FROM "vulnerabilities"
    WHERE vuln_id !~* '^CVE-[0-9]{4}-[0-9]{4,}$'
      AND jsonb_typeof(raw_data -> 'upstream') = 'array'
) AS d
WHERE v.id = d.id
  AND v."finding_identity" IS DISTINCT FROM d.identity;
