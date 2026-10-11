# Backups

*Applies to: Community Edition. The cloud's databases are backed up by
its operators.*

A StackRadar install has exactly two things worth keeping, and one of
them is a 64-character string.

## What to back up

1. **The database.** One PostgreSQL database holds everything: the
   inventory, every SBOM, the findings and their history, the users and
   sessions (`auth` schema), the scanner's keys, and the OSV / EPSS / KEV
   mirror. The mirror is most of the bytes and can be rebuilt from the
   internet, but it is cheaper to restore than to re-download, and a dump
   that includes it restores to a working install with no bootstrap wait.
2. **`API_KEY_ENCRYPTION_KEY`** (chart: `secrets.apiKeyEncryptionKey` or
   the key in `secrets.existingSecret`). Scanner keys are encrypted at rest
   with it so an admin can reveal them. A restored database with a
   different encryption key is a working install whose stored scanner keys
   are unreadable: the scanner keeps working (it authenticates against a
   hash), but nobody can read the key out of the UI again, and the
   install's own bootstrap credential has to be re-seeded. Keep the key
   with the dump, under the same protection.

Everything else is reproducible: the images are immutable tags, the chart
values are in your Git, the scanner's state is rebuilt from the cluster on
its next sweep, and the OSV mirror rebuilds itself if its tables are
empty. Nothing is on local disk outside Postgres.

## Taking a backup

The bundled Postgres under Helm:

```sh
kubectl -n stackradar exec stackradar-postgresql-0 -- \
  pg_dump -U stackradar -Fc stackradar > stackradar-$(date +%F).dump
```

Docker Compose:

```sh
docker compose exec postgres pg_dump -U stackradar -Fc stackradar > stackradar-$(date +%F).dump
```

A database you run yourself: your provider's snapshots or the same
`pg_dump` against it. The custom format (`-Fc`) is compressed and lets
`pg_restore` pick schemas; it carries `public`, `auth` and `drizzle`, so
a restore is complete.

The dump is consistent on its own (Postgres takes a snapshot for the
duration), so the apps can keep running while it is taken. A schedule is
yours to provide: the chart has no backup CronJob yet (it is the obvious
follow-up once someone asks for it), so a `CronJob` running the command
above into an object store, or your provider's snapshot schedule, is the
production answer. Daily matches how often the vulnerability data
changes; more often if the inventory history matters to you.

## Restoring

Into an empty database owned by the connecting role:

```sh
pg_restore -d "postgresql://stackradar:…@host:5432/stackradar?sslmode=require" \
  --no-owner --no-privileges stackradar-2026-10-11.dump
```

then start (or restart) the server and client. Their start-up migration
finds the journals current and does nothing; the readiness probes confirm
it. If the restored database is older than the images (a dump from before
an upgrade), the migrations between the two apply at start-up, in order,
and the release notes for those versions say what to expect.

For the bundled Postgres, restore *before* the first start by scaling the
apps to zero, `pg_restore` through `kubectl exec -i`, then scaling back:

```sh
kubectl -n stackradar scale deploy stackradar-server stackradar-client --replicas=0
kubectl -n stackradar exec -i stackradar-postgresql-0 -- \
  pg_restore -U stackradar -d stackradar --clean --if-exists --no-owner < stackradar-2026-10-11.dump
kubectl -n stackradar scale deploy stackradar-server stackradar-client --replicas=1
```

`--clean --if-exists` drops what the fresh volume's first start may already
have created.

## Proving it works

A backup nobody has restored is a hope. Once, and then after every chart
major: restore the dump into a throwaway namespace
(`helm install stackradar-restore … --set postgresql.enabled=false --set database.url=…`
against the restored database), open it, and check that a cluster, an
image and its findings are there, and that revealing the cluster's
scanner key from its cluster page works. The last check is the encryption
key being right.
