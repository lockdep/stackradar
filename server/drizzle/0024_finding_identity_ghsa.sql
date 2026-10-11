-- Backfill `vulnerabilities.finding_identity` now that a record naming no CVE
-- takes the identity of the one GitHub advisory in its group
-- (`lib/vulnerability-aliases.ts#soleGhsaIdentity`), and carry the tables
-- keyed on the identity along (`db/identity-rekey.ts`).
--
-- `GO-2026-6061` and `GHSA-hrxh-6v49-42gf` name each other under `aliases`
-- and no CVE, so both were stored stand-alone (`#GO-2026-6061`,
-- `#GHSA-hrxh-6v49-42gf`) and a component matching both counted one bug
-- twice. Both now store `#GHSA-hrxh-6v49-42gf`. The rule refuses exactly as the
-- CVE rule does: any CVE among the record's own id, `aliases` and `upstream`
-- leaves it alone (a notice naming several CVEs keeps its own `#<id>`), and so
-- do zero or several GHSAs.
--
-- Only `#…` rows can change — a row with a CVE identity names a CVE, which
-- this rule never overrides — so the scan is scoped to them (~430k rows on
-- the development mirror). A one-off catch-up, like
-- `0003_finding_identity_upstream`: the OSV sync writes the column, and
-- re-keys, on every advisory change. The identity expression is the oracle in
-- `tests/integration/findings/finding-identity.test.ts`, which holds it to the
-- TypeScript rule.
--
-- Suppressions and finding issues written against a moving record move with
-- it — the rule `rekeyMovedIdentities` applies on every sync: a keyed row's
-- identity is the identity of its `vuln_id`, the advisory the user acted on.
CREATE TEMP TABLE identity_moves AS
SELECT
    id,
    vuln_id,
    finding_identity AS from_id,
    '#' || coalesce(
        (
            SELECT CASE WHEN bool_or(ref ~* '^CVE-[0-9]{4}-[0-9]{4,}$') THEN NULL
                        WHEN count(DISTINCT lower(ref)) FILTER (WHERE ref ~* '^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$') = 1
                        THEN 'GHSA-' || substr(min(lower(ref)) FILTER (WHERE ref ~* '^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$'), 6)
                   END
            FROM jsonb_array_elements_text(
                jsonb_build_array(vuln_id)
                || coalesce(aliases, '[]'::jsonb)
                || CASE WHEN jsonb_typeof(raw_data -> 'upstream') = 'array'
                        THEN raw_data -> 'upstream'
                        ELSE '[]'::jsonb
                   END
            ) AS t(ref)
        ),
        vuln_id
    ) AS to_id
FROM "vulnerabilities"
WHERE "finding_identity" LIKE '#%';
--> statement-breakpoint
DELETE FROM identity_moves WHERE to_id = from_id;
--> statement-breakpoint
UPDATE "vulnerabilities" AS v
SET "finding_identity" = m.to_id
FROM identity_moves AS m
WHERE v.id = m.id;
--> statement-breakpoint
-- A suppression already under the new identity wins; the old one would be a dead key.
DELETE FROM "finding_states" AS fs
USING identity_moves AS m
WHERE fs.vuln_id = m.vuln_id
  AND fs.vuln_identity = m.from_id
  AND EXISTS (
        SELECT 1 FROM "finding_states" AS k
         WHERE k.org_id = fs.org_id
           AND k.package_type = fs.package_type
           AND k.package_name = fs.package_name
           AND k.vuln_identity = m.to_id);
--> statement-breakpoint
UPDATE "finding_states" AS fs
SET vuln_identity = m.to_id, updated_at = now()
FROM identity_moves AS m
WHERE fs.vuln_id = m.vuln_id AND fs.vuln_identity = m.from_id;
--> statement-breakpoint
UPDATE "issues" AS i
SET vuln_identity = m.to_id, updated_at = now()
FROM identity_moves AS m
WHERE i.scope = 'finding' AND i.vuln_id = m.vuln_id AND i.vuln_identity = m.from_id;
--> statement-breakpoint
DROP TABLE identity_moves;
