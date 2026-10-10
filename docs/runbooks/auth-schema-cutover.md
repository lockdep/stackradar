# Cutover: client database → `auth` schema in the server database

Open-source plan step 05 (10 Oct 2026) moved the client's Auth.js tables
(`users`, `accounts`, `sessions`, `verification_tokens`) from their own
`client` database into a Postgres schema named **`auth`** inside the server's
database, and rewrote the client's Drizzle chain as a single `0000_auth_schema`
migration that creates them there. A fresh install never sees two databases.
The cloud does, once: this runbook is the one-time data move for each cluster.
**Rehearse on dev first**, then prod.

A migration cannot do it, because it crosses databases. So it is a scripted
copy inside a short maintenance window, with the old database kept for a week.

## What changes, and what must happen together

- The **new client image** (built from this commit onward) reads the `auth`
  schema and its migrator writes `auth.__drizzle_migrations`. Pointed at the
  **old** client database it refuses to start (`scripts/migrate.mjs` sees
  `public.accounts` and no `auth.accounts`); pointed at the server database
  before the rows are copied it would come up with no users. So the image,
  the `DATABASE_URL` repoint and the copy land in **one window**.
- `client-secrets` (and `demo-client-secrets` on prod, for demo.stackradar.io)
  get the **server database's** connection string. Same host, same role as
  the server uses is fine; the role needs `CREATE` on that database for the
  schema (the managed-Postgres admin role has it).
- The gitops `client-migration` PreSync Job keeps running
  `npx drizzle-kit migrate`; with the new image and the repointed secret it
  writes the same journal the in-image migrator does. Nothing to change there.
- The server is untouched. Its `public.users` mirror and everything else stay.

## Steps

Shell variables: `OLD` is the client database URL, `NEW` the server
database URL (both from the current secrets; see `database-access.md` for
reaching the managed instance through the proxy pod).

1. **Hold the image.** Do not merge the promote-to-prod PR (or let dev
   auto-sync land the new client image) until step 4. On dev, pause the app's
   auto-sync for the window.

2. **Stop writes.** Scale the client Deployment(s) to zero. Sessions are
   written on sign-in and on the hourly sliding refresh, so a copy under a
   running old client would lose a few rows; zero is simpler than reasoning
   about which.

   ```bash
   kubectl -n <ns> scale deploy/client --replicas=0      # and deploy/demo-client on prod
   ```

3. **Repoint and create the schema.** Patch `DATABASE_URL` in `client-secrets`
   (and `demo-client-secrets`) to `$NEW`. Then create the empty `auth` tables
   with the new image as a one-shot initializer — the same thing the chart's
   optional initializer Job does:

   ```bash
   kubectl -n <ns> run client-init --rm -it --restart=Never \
     --image=<new client image@digest> \
     --env=MIGRATE_EXIT_AFTER=true --env=DATABASE_URL="$NEW" --env=DATABASE_CA_CERT="$CA" \
     -- node server.js
   ```

   Expect `client migrations applied` and `auth.__drizzle_migrations` with one
   row. (`-- node server.js` is the CMD; the entrypoint exits before it runs.)

4. **Copy the rows.** Two passes so the parent table lands before its
   children; `pg_dump --data-only` emits `COPY public.<table> (<columns>)`,
   and the `sed` turns the schema into `auth`. The explicit column list is what
   makes the new `password_hash` / `must_change_password` / `failed_logins` /
   `locked_until` columns (client migration `0004`, never applied on prod)
   take their defaults.

   ```bash
   pg_dump --data-only --no-owner --no-privileges -t public.users "$OLD" \
     | sed -E 's/^COPY public\./COPY auth./' \
     | psql "$NEW" -v ON_ERROR_STOP=1 --single-transaction

   pg_dump --data-only --no-owner --no-privileges \
       -t public.accounts -t public.sessions -t public.verification_tokens "$OLD" \
     | sed -E 's/^COPY public\./COPY auth./' \
     | psql "$NEW" -v ON_ERROR_STOP=1 --single-transaction
   ```

5. **Verify.** Row counts equal per table; the demo user still flagged; the
   case-insensitive unique index present.

   ```bash
   for t in users accounts sessions verification_tokens; do
     echo "$t: $(psql "$OLD" -Atc "select count(*) from public.$t") → $(psql "$NEW" -Atc "select count(*) from auth.$t")"
   done
   psql "$NEW" -Atc "select indexname from pg_indexes where schemaname='auth' and tablename='users'"
   psql "$NEW" -Atc "select email from auth.users where demo"          # prod only
   ```

6. **Deploy.** Resume auto-sync / merge the promote PR so the new client image
   rolls out; the PreSync `client-migration` Job finds the journal complete
   and does nothing. Scale back up. Sign in with an existing account: the
   copied `sessions` rows mean browsers that were signed in stay signed in.
   Check `/api/health/ready` on the client and that `/demo/enter` (prod) still
   mints a session.

7. **Keep, then drop.** Leave the `client` database untouched for **one week**
   as the rollback (rollback = repoint the secret back and redeploy the
   previous image; nothing written in the meantime is carried back). After
   the week, drop it, and remove it from the managed-Postgres database list
   and the gitops README's "what must exist" step.

## Local development

`scripts/init-db.sql` no longer creates the `client` database. An existing
Compose volume still has one; it is unused. Point `client/.env.local` at the
`server` database and run `pnpm db:migrate:boot` (or `MIGRATE_ON_START=true`
on either app) to create the `auth` schema. Your old local users are in the
old database; copy them with the same two `pg_dump` lines against
`localhost:5444`, or just sign in again.
