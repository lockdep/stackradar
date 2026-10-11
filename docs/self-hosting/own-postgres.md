# Using your own Postgres

*Applies to: Community Edition. The cloud runs its own managed database;
nothing here is needed there.*

The chart bundles a single-node PostgreSQL so that a bare `helm install`
works. It is one node, no HA, no automated backups and no managed major
upgrades: fine for evaluation and small installs, and the chart says so at
install time. A database you run, or a managed one, is the production
shape. This page is how to point the install at it, and how to move an
existing install off the bundled one.

## What the database needs to be

* **PostgreSQL 18** is what the bundled database, the Compose quickstart
  and the test suite run. Older major versions are not tested; if you run
  one and it works, say so in Discussions so this line can change.
* **One database, one role.** Both apps connect with the same URL. The
  server's tables live in `public`, the client's Auth.js tables in a schema
  named `auth`, and each app's migration journal in its own schema
  (`drizzle` for the server, `auth` for the client). The role needs
  `CREATE` on the database, because the first start creates those schemas,
  and ownership of what it creates; a plain `CREATE DATABASE stackradar
  OWNER stackradar` is enough.
* **TLS, stated explicitly.** The URL must say what it wants:
  `sslmode=require`, or `verify-ca` / `verify-full` with the provider's CA
  certificate, for anything reachable over a network. `sslmode=prefer` is
  accepted for a Postgres on a private network (the Compose quickstart's);
  a URL with no `sslmode` at all is refused by both apps, and so is
  `sslmode=disable`. For `verify-*`, give the apps the CA as PEM:
  `database.existingSecret.caCertKey` in the chart, `DATABASE_CA_CERT`
  under Compose.
* **Size.** The OSV mirror is most of it: roughly 40 MB for `Alpine` alone,
  low single-digit gigabytes for the default ecosystem list, about 12 GB
  for the whole corpus. Your own data (images, SBOMs, findings, history)
  is small beside it. Connections: each app holds a small pool; a dozen
  connections per replica is a safe budget.

## Pointing a new install at it

Put the connection string in a Secret under the key `url`, then:

```yaml
# my-values.yaml
postgresql:
  enabled: false
database:
  existingSecret:
    name: stackradar-db        # key `url`; optionally `caCertKey: ca.crt`
```

```sh
kubectl -n stackradar create secret generic stackradar-db \
  --from-literal=url='postgresql://stackradar:…@db.example.com:5432/stackradar?sslmode=verify-full' \
  --from-file=ca.crt=./provider-ca.pem
helm install stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --namespace stackradar --create-namespace -f my-values.yaml
```

`database.url` inline works too; `postgresql.enabled: true` together with
either is refused at render time rather than guessed about. Under Compose,
replace the two `DATABASE_URL`s and drop the `postgres` service.

Both apps apply their migration chains at start-up under a shared advisory
lock, so the first start against an empty database creates everything and
later starts find nothing to do. Nothing has to be run by hand.

## Moving an existing install off the bundled Postgres

The custom-format dump carries the `public`, `auth` and `drizzle` schemas
and both apps' migration journals, which is what makes the next start a
no-op rather than a re-migration.

1. Stop the writers, so the dump is consistent and nothing lands in the
   old database after it:
   ```sh
   kubectl -n stackradar scale deploy stackradar-server stackradar-client --replicas=0
   ```
2. Dump:
   ```sh
   kubectl -n stackradar exec stackradar-postgresql-0 -- \
     pg_dump -U stackradar -Fc stackradar > stackradar.dump
   ```
3. Restore into the new database, created empty with the role as its
   owner:
   ```sh
   pg_restore -d "postgresql://stackradar:…@db.example.com:5432/stackradar?sslmode=require" \
     --no-owner --no-privileges stackradar.dump
   ```
   `--no-owner` because the role names differ between the two databases
   more often than not; the connecting role owns everything afterwards.
4. Create the Secret and flip the values as above, then `helm upgrade`.
   The pods come up against the new database and their readiness probes
   confirm the migration journals are current.
5. Check the dashboard: the same clusters, images and findings. The
   scanner needs nothing; its key is in the database you just moved.
6. When satisfied, delete the retained claim:
   `kubectl -n stackradar delete pvc data-stackradar-postgresql-0`.

Under Compose the same steps are `docker compose stop server client`,
`docker compose exec postgres pg_dump -U stackradar -Fc stackradar > stackradar.dump`,
the restore, the two URLs, and `docker compose up -d`.

## Changing the bundled database's password

Postgres set its password when it initialised the volume, so changing
`postgresql.auth.password` in the values alone does nothing to the
database. Change both in one go:

```sh
kubectl -n stackradar exec stackradar-postgresql-0 -- \
  psql -U stackradar -c "ALTER ROLE stackradar PASSWORD 'new-password'"
helm upgrade stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --namespace stackradar -f my-values.yaml      # with the new password in it
```

The pods restart with the new URL. Do this once, early, as the chart's
install-time WARNING asks; the longer the fixture password stays, the more
places it has been copied to.
