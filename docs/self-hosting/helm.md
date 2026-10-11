# Running StackRadar on Kubernetes with Helm

*Applies to: Community Edition. The cloud at app.stackradar.io runs the same
images from its own manifests; nothing here is needed there.*

The chart is the community edition's real shape: the server, the UI, a
bundled Postgres and the scanner — already scanning the cluster it lands
in. One command, then log in and the cluster's own images are on the
dashboard. It lives in [lockdep/helm-charts](https://github.com/lockdep/helm-charts)
(`charts/stackradar`), is published as `oci://ghcr.io/lockdep/helm-charts/stackradar`
and as a classic repository at `https://lockdep.github.io/helm-charts`, and
its [README](https://github.com/lockdep/helm-charts/blob/main/charts/stackradar/README.md)
is the values reference. This page is the walkthrough.

## Install it

```sh
helm install stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --namespace stackradar --create-namespace

kubectl -n stackradar port-forward svc/stackradar-client 3000:3000
```

Open <http://localhost:3000> and sign in with

| | |
|---|---|
| Email | `admin@stackradar.local` |
| Password | `admin` |

You are asked to change the password before anything else loads. Do it.

What came up (`kubectl -n stackradar get pods`):

| Pod | What it is |
|---|---|
| `stackradar-postgresql-0` | PostgreSQL 18, one node, a 10Gi volume that `helm uninstall` keeps |
| `stackradar-server-…` | the API, the job worker and the OSV/EPSS/KEV sync schedule in one process (the `monolith` topology) |
| `stackradar-client-…` | the web UI |
| `stackradar-scanner-watcher-…` | the scanner, pointed at `stackradar-server` in-cluster |

Both apps apply their own migrations at start-up under a shared advisory
lock, so there is no migration step; the server also seeds the default
organisation and the cluster `local` from the scanner's bootstrap
credential before it reports ready. The scanner starts beside it and its
first heartbeats may be rejected for a few seconds until that seed has
run — expected, and it retries.

On a laptop cluster (kind, minikube, Docker Desktop) add
[`values-quickstart.yaml`](https://github.com/lockdep/helm-charts/blob/main/charts/stackradar/values-quickstart.yaml):
trimmed requests and an Alpine-only OSV mirror that bootstraps in about two
minutes. The bare install is otherwise the same.

## What you see first

A yellow strip above every page says **Vulnerability database is being
built**. The server bootstraps its own OSV mirror in the background for the
default ecosystem list — about 1.2 GB compressed, 5–25 minutes depending on
your connection — and EPSS and KEV right after. Meanwhile the scanner has
already swept the cluster: the Containers and Images pages fill up with
what is running (on a kind cluster: kindnet, coredns, local-path-provisioner
and StackRadar itself), and findings appear on each image as the mirror
goes live and the matching jobs run. Nothing to do; the strip goes away on
its own.

## Keep it: replace the fixtures

`helm install` printed a WARNING naming every public fixture still in
effect. Every install that leaves them at their defaults shares them, and
with the fixture scanner key any pod in the cluster that can reach the
server Service can upload SBOMs as the local cluster. Nothing in the chart
is ever generated for you — a generated secret would change on every GitOps
render and rotate the scanner key each sync — so set your own:

```yaml
# my-values.yaml
secrets:
  internalServiceKey: <openssl rand -hex 32>
  apiKeyEncryptionKey: <openssl rand -hex 32>      # set once; changing it later makes stored scanner keys unreadable
  authSecret: <openssl rand -base64 32>
scanner:
  stackradar:
    clusterId: <uuidgen | tr A-Z a-z>
    apiKey: <openssl rand -hex 32>
```

Or provision Secrets with your own tooling and reference them
(`secrets.existingSecret.name`, `scanner.stackradar.existingSecret`,
`postgresql.auth.existingSecret.name`); the README's "Secrets" section has
the key names. The database password is the one that cannot simply be
flipped afterwards: Postgres set it when it initialised the volume, so
either set `postgresql.auth.password` before the first install, or change
it in Postgres (`ALTER ROLE stackradar PASSWORD '…'`) and in the values in
the same `helm upgrade`.

```sh
helm upgrade stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --namespace stackradar -f my-values.yaml
```

A `helm upgrade` with no value changes changes nothing: no Secret is
rewritten, no key rotates, the start-up migration finds nothing to do.

## Reach it from outside

Port-forwarding is the default. For a hostname, enable the Ingress (or a
Gateway API `HTTPRoute`; never both):

```yaml
ingress:
  enabled: true
  hostname: stackradar.example.com
  ingressClassName: nginx
  tls:
    - secretName: stackradar-tls
      hosts: [stackradar.example.com]
```

Both route `/` to the UI. `ingress.exposeApi: true` adds `/v1` to the server
for uploading SBOMs from outside the cluster; the bundled scanner needs no
route. `externalUrl` pins the browser-facing URL (`APP_URL`, `AUTH_URL`)
when it cannot be derived from the hostname — an http-only Ingress, a
non-standard port.

## Sign-in providers

Local username/password is on by default; the admin creates further local
users from the Users tab. For an identity provider:

```yaml
auth:
  oidc:
    issuer: https://idp.example.com/realms/stackradar   # Keycloak, Authentik, Entra ID, Okta, Zitadel
    clientId: stackradar
    clientSecret: …                                     # or existingSecret.name with client-id / client-secret
    name: Keycloak                                      # the button label
    adminGroup: platform-admins                         # optional: members are platform admins
  local:
    enabled: false                                      # hide the form once the IdP works
```

Callback URL: `<externalUrl>/api/auth/callback/oidc`. `auth.github.*` and
`auth.google.*` work the same way. A half-configured provider fails the
render; so does a configuration with no sign-in method at all. With more
than one client replica, rate-limit `POST /api/auth/local` at the ingress —
the local sign-in's per-address limit is in-process.

Locked out of the admin account:

```sh
kubectl -n stackradar exec deploy/stackradar-client -- \
  node scripts/admin-reset-password.mjs admin@stackradar.local
```

## Resources

| | |
|---|---|
| Server (`monolith`), during the OSV import | up to ~2 GB (`server.resources.limits.memory: 2Gi`, `--max-old-space-size=1536`) |
| Server, steady state | a few hundred MB; syft runs for the nightly platform scans peak within the limit |
| Postgres, `Alpine` only | ~40 MB on disk |
| Postgres, default ecosystem list | not yet measured — budget low single-digit GB; the default volume is 10Gi |
| Postgres, the whole corpus (`vulnerabilityData.osvEcosystems: "*"`) | ~12 GB for the two mirror tables, 2.5 GB of downloads |
| Scanner | 512Mi request, 1Gi limit, a 4Gi scratch volume for image layers (the subchart's defaults) |

No CPU limits anywhere, by house rule: CPU is compressible and a limit only
throttles. Clusters that enforce LimitRanges can set them per component.

## The bundled Postgres, and leaving it

It is one node, no HA, no automated backups and no managed major upgrades.
Fine for evaluation and small installs; say so to yourself before relying
on it. Back it up:

```sh
kubectl -n stackradar exec stackradar-postgresql-0 -- \
  pg_dump -U stackradar -Fc stackradar > stackradar.dump
```

### Moving to your own Postgres

1. Stop the writers: `kubectl -n stackradar scale deploy stackradar-server stackradar-client --replicas=0`.
2. Dump as above, restore into the new database:
   `pg_restore -d "postgresql://…/stackradar?sslmode=require" --no-owner stackradar.dump`.
   The custom-format dump carries the `public`, `auth` and `drizzle`
   schemas and both apps' migration journals, which is what makes the next
   start a no-op.
3. Put the connection string in a Secret under the key `url` — it must say
   `sslmode=require` (or `verify-ca`/`verify-full` with
   `database.existingSecret.caCertKey`) for a managed database — and flip
   the values:
   ```yaml
   postgresql:
     enabled: false
   database:
     existingSecret:
       name: stackradar-db
   ```
4. `helm upgrade`. The pods come up against the new database.
5. When satisfied, delete the retained claim: `kubectl -n stackradar delete pvc data-stackradar-postgresql-0`.

## Split topology, GitOps and the initializer

`topology: split` renders the worker as its own Deployment and the feeds as
CronJobs — the cloud's shape, for installs that scale the pieces
separately. The schedules (`sync.*.schedule`, UTC) apply in both
topologies.

Flux and Argo CD install the chart as any other; nothing is generated at
render time, so a sync never rotates a secret. `initializer.enabled: true`
moves the migrations from the pods to two `pre-install`/`pre-upgrade` hook
Jobs (Argo CD runs them as `PreSync` on every sync; they no-op when the
database is current). It needs an external database and the application
secrets from existing Secrets, because a hook runs before anything else in
the release exists; the README's "Migrations and the initializer" section
has the rules.

## Scanner behind a TLS-intercepting proxy

If the scanner logs certificate errors against registries or the API, do
not disable verification; give the agent the proxy's CA instead. The
scanner chart takes it as a ConfigMap (`caBundle.configMapName`; see
"Behind a TLS-intercepting proxy" in the
[scanner chart README](https://github.com/lockdep/stackradar-scanner/blob/main/helm/README.md)):

```sh
kubectl create configmap stackradar-ca -n stackradar \
  --from-file=ca-certificates.crt=/path/to/your-ca.crt
helm upgrade stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  -n stackradar --reuse-values \
  --set scanner.caBundle.configMapName=stackradar-ca
```

## Ingest rate limits and replicas

Per-key token buckets guard `POST /v1/sboms/upload/cyclonedx` (60 burst,
30/min sustained) and `POST /v1/inventory` (5 burst, 2/min);
`server/src/middleware/rate-limit.ts` is the definition. The buckets live
in memory per process, so with N server replicas the effective limit is N×
the configured one, which still bounds a misbehaving scanner. Protection
against unauthenticated floods is the Ingress's job (`limit-rps` or your
provider's equivalent), not the application's.

## Where to look when something is wrong

- `kubectl -n stackradar get pods` — a pod stuck `0/1` is waiting on its
  readiness probe. `kubectl -n stackradar logs deploy/stackradar-server`
  says why: a refused `DATABASE_URL`, a missing variable, a half-set
  bootstrap pair, a migration that failed.
- `kubectl -n stackradar exec deploy/stackradar-server -- wget -qO- localhost:3001/api/health/ready`
  and the same on the client (`localhost:3000`) name the problem rather
  than the value.
- The scanner not Ready with `control plane rejected the credentials` in
  its logs for more than a minute: its `scanner.stackradar.*` credential
  and the server's bootstrap pair are the same Secret by construction, so
  check that `scanner.stackradar.existingSecret`, when set, holds
  `cluster-id` and `api-key`, and that the server's logs say
  "default organization and bootstrap cluster ready".
- The admin area's **OSV** tab shows the mirror's state, the ecosystems it
  carries against the configured list, and recent sync runs. With
  `metrics.serviceMonitor.enabled` and `metrics.prometheusRule.enabled`
  the same signals reach Prometheus (`StackRadarOsvMirror*` alerts).
- `helm template` fails with a sentence naming the value and the fix for
  every ambiguous or impossible configuration (two databases, a
  half-configured provider, a blanked secret, worker knobs in `monolith`,
  the initializer without existing Secrets).

## What this is not

Several clusters in one dashboard: the community edition is the dashboard
for the cluster it runs in, and the API refuses a second cluster. That is
the cloud, where you install only the scanner chart with a key from
app.stackradar.io. See [docker-compose.md](docker-compose.md) for the
laptop try-out without a cluster.

## See also

[users-and-login.md](users-and-login.md) for roles and the locked-out
admin, [oidc.md](oidc.md) for the provider recipes, [own-postgres.md](own-postgres.md)
for the full move off the bundled database, [upgrading.md](upgrading.md)
before every upgrade, and [backup.md](backup.md) for what to keep and how
to prove a restore works.
