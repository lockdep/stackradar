# Runbook: database access and reset

Operational snippets for working with a deployed database. Everything here
runs against real data — read each warning before pasting anything.

## Proxy to the managed database

The managed PostgreSQL instances are not directly reachable; go through an
ephemeral socat pod in the cluster. Each environment has its own cluster and
database. Always pass `--context` explicitly so you never run against the
wrong cluster by accident. Local ports differ so both tunnels can run at once.

| Environment | kubectl context                            | Local port | DB host (private, port 25060)                                                  |
|-------------|--------------------------------------------|------------|--------------------------------------------------------------------------------|
| development | `do-fra1-k8s-fra1-stack-radar-development` | 5432       | `private-db-postgresql-fra1-development-do-user-1559317-0.e.db.ondigitalocean.com` |
| production  | `do-fra1-k8s-fra1-stack-radar-prod`        | 5433       | `private-db-postgresql-fra1-prod-do-user-1559317-0.a.db.ondigitalocean.com`        |

If a host changes, look it up with `doctl databases list` and
`doctl databases get <id> -o json` (`private_connection.host`).

### Development

```bash
CTX=do-fra1-k8s-fra1-stack-radar-development

# One-time (per cluster): create the proxy pod. Skip if `kubectl --context $CTX -n default get pod pg-proxy` exists.
kubectl --context $CTX -n default run pg-proxy \
  --image=alpine/socat --restart=Never \
  --command -- socat -d -d TCP-LISTEN:5432,fork,reuseaddr \
  TCP:private-db-postgresql-fra1-development-do-user-1559317-0.e.db.ondigitalocean.com:25060

# Every session: forward local 5432 → pod 5432
kubectl --context $CTX -n default port-forward pod/pg-proxy 5432:5432 --address 127.0.0.1
```

Connect to `127.0.0.1:5432` (`sslmode=require`).

### Production

> [!WARNING]
> This is live customer data. Prefer read-only sessions
> (`SET default_transaction_read_only = on;`) and never paste the reset block
> below into a session on port 5433.

```bash
CTX=do-fra1-k8s-fra1-stack-radar-prod

# One-time (per cluster): create the proxy pod. Skip if `kubectl --context $CTX -n default get pod pg-proxy` exists.
kubectl --context $CTX -n default run pg-proxy \
  --image=alpine/socat --restart=Never \
  --command -- socat -d -d TCP-LISTEN:5432,fork,reuseaddr \
  TCP:private-db-postgresql-fra1-prod-do-user-1559317-0.a.db.ondigitalocean.com:25060

# Every session: forward local 5433 → pod 5432
kubectl --context $CTX -n default port-forward pod/pg-proxy 5433:5432 --address 127.0.0.1
```

Connect to `127.0.0.1:5433` (`sslmode=require`).

### Credentials and connecting

The database name, user and password are in the DigitalOcean
control panel or via `doctl databases connection <id>` (ids from
`doctl databases list`). Example:

```bash
psql "postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE?sslmode=require"   # dev
psql "postgresql://USER:PASSWORD@127.0.0.1:5433/DATABASE?sslmode=require"   # prod
```

Quick check that the tunnel is up: `pg_isready -h 127.0.0.1 -p <port>`.
Confirm which database you are in before doing anything: `SELECT current_database(), inet_server_addr();`

### Cleanup

The pod is ephemeral and may disappear on node recycling; just recreate it.
Remove it explicitly when no longer needed:

```bash
kubectl --context <context> -n default delete pod pg-proxy
```

## Reset a database schema

> [!CAUTION]
> **Destructive.** The block below drops **every table in the `public`
> schema** of whatever database you are connected to, with CASCADE. It is for
> wiping a development/staging database so migrations can re-run from zero.
> Confirm which database your session points at (`SELECT current_database();`)
> before running it. There is no undo.

```sql
DO $$ DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
END $$;
```

Drizzle keeps its migration journal outside `public`, so drop that too or the
deploy-time migration job will think everything is already applied:

```sql
DROP TABLE drizzle.__drizzle_migrations;
```

The client's Auth.js tables and its own journal live in the `auth` schema of
the same database (open-source plan step 05); wiping those is a separate,
equally deliberate step — it signs every user out:

```sql
DROP SCHEMA auth CASCADE;
```

Migrations themselves are applied only by the deploy on the dev and prod
databases (ArgoCD PreSync Jobs) — never run `pnpm db:migrate` by hand there
(see the root `CLAUDE.md`). Self-hosted installs apply them at boot.
