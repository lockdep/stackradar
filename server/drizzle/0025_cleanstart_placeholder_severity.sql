-- Cleanstart's CVSS is a placeholder: one vector, `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`
-- (9.8), on every record it scored at all — 1,257 of 1,257 on 2026-09-30 —
-- and nothing on the other 77%. `osv-sync/cvss.ts` (`PLACEHOLDER_SCORERS`)
-- now drops that entry at parse time, so the record is unscored and borrows a
-- real score from the other records of its CVE (`severity-fill.ts`).
--
-- `severity_level` / `cvss_score` are stamped at ingest, so rows already in
-- the mirror keep the 9.8 until re-synced. This resets them the way the
-- parser now would; `severity` (the vectors as published) is left as is.
-- They stay unscored until the next severity fill — the hourly sync's, for
-- any identity it touches, or `pnpm osv-sync --fill-severity` for all.
UPDATE "vulnerabilities"
SET "severity_level" = 'unknown',
    "cvss_score" = NULL,
    "severity_source" = NULL
WHERE "id_prefix" = 'CLEANSTART'
  AND "severity_source" IS NULL
  AND "cvss_score" IS NOT NULL
  -- Only rows whose vectors are all the placeholder: a score parsed from a
  -- text label, or from a real vector, is the publisher's own and stays.
  AND jsonb_array_length(coalesce("severity", '[]'::jsonb)) > 0
  AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements("severity") AS s
        WHERE regexp_replace(s ->> 'score', '^CVSS:[0-9]+(\.[0-9]+)?/', '') <> 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
