-- Repair the SUSE and openSUSE rows of the OSV mirror, whose `match_key` was
-- built from a purl osv.dev's exporter writes with the qualifier glued onto the
-- name (`pkg:rpm/suse/curl&distro=SUSE%20Linux%20Enterprise%20Server%2015%20SP7`,
-- no `?`). Read literally the package was named `curl&distro=SUSE Linux…`, so
-- every one of these rows carried a key no component could ever meet:
--
--   rpm/suse|curl&distro=suse linux enterprise server 15 sp7  →  rpm/suse|curl
--
-- `matching/identity.ts#repairGluedQualifiers` now re-punctuates the purl at
-- ingest, so rows written from here on are correct; this catches up the ones
-- already stored (~153k on 2026-09-06). The stored base `purl` had the same
-- string percent-encoded into its name and is trimmed the same way. Scoped by
-- family so the scan is over the two ecosystems, not the whole 5.5M-row table;
-- a row of either family whose key has no glued qualifier is left alone.
UPDATE "vulnerability_affected_packages"
SET
    "match_key" = regexp_replace("match_key", '&distro=.*$', ''),
    "purl" = regexp_replace("purl", '%26distro%3D.*$', '')
WHERE "ecosystem_family" IN ('SUSE', 'openSUSE')
  AND "match_key" LIKE '%&distro=%';
