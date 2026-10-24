# Plan: a read API and an MCP server, so an agent can ask what to fix

Status: proposed 2026-10-22, nothing implemented. Written from a read of
`server/src/middleware/auth.ts`, `server/src/routes/public.routes.ts`,
`server/src/db/schema/api-keys.ts`, `server/src/repositories/cluster.repository.ts`,
the read-side controllers (`remediation`, `vulnerability`, `image`,
`component`, `search`, `radar-score`), `docs/authorization-matrix.md`,
`docs/ARCHITECTURE.md` § 2, the chart's `ingress.yaml` and the hosted
`network-policies.yaml`.

## Why

The question a coding agent asks, sitting in a GitOps repository, is "which
of the images running in my cluster carry findings that matter, and what do
I change to make them go away". That is the product's one sentence (the
README's first paragraph), and the server already answers it: the Fixes list
(`fixesForOrg`, `services/remediation.service.ts`) is a ranked list of moves
with the chart version or tag that clears each finding, and the vulnerability
overview, the image page and the package occurrences answer the follow-ups.

Nothing outside a browser can reach any of it. The server has exactly one
machine credential, the scanner key, scoped `sbom:write` and admitted only to
the four `/v1` ingest routes; every read route mounts `requireInternal` and
answers 403 to a key, by design (ADR 0002, `auth.ts` `requireInternal`'s
comment: a leaked scanner key's blast radius is that cluster's ingest). So
the work is not "an MCP server": it is a second kind of key that may read,
a small versioned read surface for it, and then the MCP endpoint as a thin
layer over that surface. Trivy, Snyk and others ship MCP servers that answer
"what CVEs are in this artifact"; this one answers "what is running, what is
exploited, and which `values.yaml` line fixes it", which is the difference
the product exists for.

The order matters because the first two phases are useful on their own
(plain `curl`, a CI gate, a Grafana panel) and because the MCP layer must
not grow its own data access: a tool is a read route with a description.

## Principles

1. **A read key is not a scanner key.** Same `api_keys` table, same hashing,
   same middleware, but `cluster_id` null, scope `read`, and never admitted to
   `/v1/inventory`, `/v1/sboms/*` or `/v1/heartbeat`. A scanner key is never
   admitted to the read surface either; the scope check does both.
2. **The read surface is its own contract, versioned under `/v1`.** It does
   not re-mount the `/api` controllers: their shapes are the UI's and change
   with it. Thin `/v1` controllers call the same services and repositories
   and return stable, documented, smaller shapes.
3. **Tenancy is enforced in the `/v1` controllers exactly as in `/api`**
   (ARCHITECTURE § 2.4): the org comes from the key row, every id-taking
   handler goes through `db/tenancy.ts` or a guard, missing and forbidden
   are both 404.
4. **Read-only, in every layer.** No tool, route or scope in this plan writes
   anything but `last_used_at`. Acknowledging or ignoring a finding through
   an agent is a later plan with its own scope name.
5. **Compact by construction.** Every list is paged (default 20, maximum
   100), every row carries ids the next call takes, and no route or tool
   returns an SBOM document. An agent's context is the scarce resource;
   a tool result that is a 40 000-row package list has failed.
6. **Both editions, one code path.** Read keys and `/v1/mcp` exist in
   community and cloud alike, with no plan gate; the cloud's existing
   limits apply to what the org can hold, not to whether it may read it.
7. **The MCP server owns no data access.** Each tool is one call into the
   same service a `/v1` route calls, with the same tenancy probe and the
   same rate bucket, so the two surfaces cannot drift.

## Surface inventory after the change

| Principal | Proof | Scope | Reaches |
|---|---|---|---|
| Scanner key (exists) | `X-API-Key`, `cluster_id` set | `sbom:write` | `/v1/heartbeat`, `/v1/inventory`, `/v1/sboms/check`, `/v1/sboms/upload/cyclonedx` |
| **Read key (new)** | `X-API-Key` or `Authorization: Bearer`, `cluster_id` null | `read` | `/v1/fixes`, `/v1/findings`, `/v1/vulnerabilities/:id`, `/v1/images`, `/v1/images/:id`, `/v1/images/:id/packages`, `/v1/packages`, `/v1/clusters`, `/v1/mcp` |
| User via BFF (exists) | `X-Internal-Key` + identity headers | all | everything under `/api`, including minting and revoking read keys |

The hosted ingress allow-list (`stackradar-gitops/apps/stack-radar/base/`,
"the six public /v1 paths on api.stackradar.io") grows by the new paths in
the same pull request as phase 2; the chart's `ingress.exposeApi` already
routes the `/v1` prefix and needs no change.

## Phases

Each phase is one pull request, in order. Phases 1 and 2 are the substance;
phase 3 is the feature the plan is named for; phase 4 is deferred until
someone asks.

### Phase 1: read keys

A second kind of API key: org-scoped, read-only, minted and revoked by an
org admin or owner in both editions. Label `enhancement`.

Server:

- `lib/api-key.ts`: `generateReadKey()` returning `srr_` plus 32 base64url
  characters. The fixed prefix makes a read key recognisable in a log line,
  a leaked `.env` and, later, a GitHub secret-scanning pattern; scanner keys
  stay as they are. `keyPrefix` stores the first 12 characters (`srr_` plus
  eight), which the column already allows; `apiKeyPrefix` takes a length.
- `repositories/api-key.repository.ts` (new, so `cluster.repository.ts`
  stays the scanner key's): `createReadKey(orgId, createdBy, name,
  expiresAt?)`, `listReadKeys(orgId)`, `revokeReadKey(orgId, keyId)`. Rows
  carry `clusterId: null`, `scopes: ['read']`, `name` as given,
  `keyCiphertext: null`. Read keys are shown once and never revealed again:
  the vault exists because rolling a scanner Secret is painful, and a read
  key is replaced by minting another. Listing excludes revoked rows older
  than 30 days and never returns hash or ciphertext.
- A cap of 10 active read keys per org, both editions, `409 read_key_limit`
  above it. Not a plan limit; a tidiness limit, like the member cap's shape
  but constant.
- `middleware/auth.ts`: `getApiKey` also reads `Authorization: Bearer
  <key>` (MCP clients send a bearer header, and `curl` users expect it).
  Both headers resolve through the same `validateApiKey`; the `sbom:write`
  routes keep working unchanged. `validateApiKey` touches `last_used_at` at
  most once a minute per key if it does not already.
- Routes, `requireAuth, requireInternal, requireOrg, requireAdminOrOwner`:
  `GET /api/organizations/:id/read-keys`, `POST …/read-keys` (body `{ name,
  expiresAt? }`, 201 with the plaintext once), `DELETE …/read-keys/:keyId`.
  No `requireMultiCluster`: the community edition may mint read keys, since
  this is not cluster CRUD. The demo org is refused by the existing
  read-only guard on non-safe methods.
- `requireScope('read')` is the whole authorisation for the read surface.
  The fixture scope strings nothing enforces (`sbom:read`, `workload:read`,
  `workload:write` in `tests/fixtures/seed-data.ts`) go; `read` and
  `sbom:write` are the vocabulary.

Client:

- A **Read keys** section in organisation settings beside the scanner keys
  tab (`components/organization-settings/ApiKeyTab.tsx`; the view decides
  per edition which to draw, and this one is drawn in both). A table of
  name, prefix, created, last used, expires, with Create and Revoke. The
  create dialog shows the key once with a copy button and a one-line
  example `curl` against `/v1/fixes`. No BFF file: the catch-all proxies it.
- Members see the list; only admin and owner see Create and Revoke, the same
  gate the scanner tab uses.

Tests:

- `tests/integration/api-keys/read-key-crud.test.ts`: mint, list (masked),
  revoke, the cap, the role gate, the demo refusal, the expiry.
- `tests/integration/api-keys/api-key-auth.test.ts`: a read key is 403 on
  all four ingest routes; a scanner key is 403 on a read route (phase 2
  adds the route; until then assert on `/v1/fixes` returning 403 not 404
  can wait); a bearer header authenticates the same as `X-API-Key`.

Acceptance: an org admin can mint a read key in a community install, see
it once, and `curl -H "Authorization: Bearer srr_…"` against any ingest
route is a 403 naming the missing scope.

### Phase 2: the read surface under `/v1`

Eight read routes, one contract document, the hosted allow-list. Label
`enhancement`.

Mounting, in `routes/public.routes.ts` or a sibling `read.routes.ts` it
imports: `requireAuth, requireScope('read'), readLimit` where `readLimit =
rateLimitByApiKey({ capacity: 120, refillPerMinute: 60, name: 'read' })`.
Internal (BFF) requests pass `requireScope` implicitly, which is fine: the
UI may call these too. API-key contexts have `orgId` from the key row and no
`role` or `org` object (`requireOrg` sets those only for internal auth), so
the `/v1` controllers read `auth.orgId` and nothing else from the context.

Routes and what each returns, in `controllers/read/*.controller.ts`, each a
thin shape over an existing service:

| Route | Source | Returns |
|---|---|---|
| `GET /v1/fixes` | `fixesForOrg` | `totals`, then `fixes[]` trimmed to `id, kind, measured, evidence, subject, release, from, to, bump, cluster, scope, control, cleared, riskRemoved, upperBound, containers, delivery, target`. `?include=no-recommendation` adds `noRecommendation[]`. `?cluster=`, `?control=`, `?measured=true` filter in the controller. |
| `GET /v1/findings` | the service behind `vulnerabilityController.list` | the org's findings with `severity, kev, search, cluster, namespace, control, tier, sort, order, limit, offset`, the same comma-joined conventions as `clusterVulnerabilitiesQuerySchema`; each row carries `vulnId`, the identity, score contribution, counts of images and containers. |
| `GET /v1/vulnerabilities/:vulnId` | `vulnerabilityController.overview`'s services | `vulnerability`, `occurrences` (images, then workloads per image), `exposure`, `remediation`. 404 outside the org, as today. |
| `GET /v1/images` | `imageRepository` behind `imageController.getAll` | `?search=` over the reference, `?cluster=`, `?namespace=`, paged; rows `id, reference, digest, cluster, containers, counts, radarScore, control`. |
| `GET /v1/images/:id` | `findById`, `findStatsById`, `findDeployments`, `getUpgrade`, `getBaseUpgrade` | the image, where it runs (release, namespace, Argo application when known), its counts and score, the recommended move and the base rebuild when either exists. Findings are not inlined: `/v1/findings?image=` is the page for that. |
| `GET /v1/images/:id/packages` | the component list behind `/api/components` scoped to one image | paged packages with `name, version, purl, ecosystem, layer (base/application), findings`; `?vulnerable=true` keeps only packages with findings. |
| `GET /v1/packages` | `packageRepository.findPackageOccurrences` | `?name=&version=` (version optional, as the existing schema reads it), the running images and containers that carry it. This is "am I running log4j 2.14.1 anywhere". |
| `GET /v1/clusters` | `clusterController.names` and scanner health | id, name, scanner last seen and version, so an agent can scope the other calls. |

Every list response is `{ items, total, limit, offset, nextOffset }` with
`nextOffset` null on the last page. Severities, tiers and control values
are the same strings the UI uses. Errors are the existing `AppError` shape.

Contract: `docs/contracts/read-api-v1.md` in the style of
`inventory-v3.md`, one section per route with the query parameters and a
response example, plus `docs/contracts/read-api-v1.openapi.yaml`,
hand-written. A test (`tests/integration/read-api/contract.test.ts`) walks
the OpenAPI paths and asserts each is mounted and each mounted `/v1` read
route is in the file, so the two cannot drift silently; it does not try to
validate shapes against the schema.

Deployment:

- `stackradar-gitops` (prod) and `-development`: the ingress for
  `api.stackradar.io` and the `server-ingress` NetworkPolicy comment gain
  the new paths; the comment stops saying "six".
- Chart: nothing. `ingress.exposeApi` routes the prefix. `helm.md` gets a
  sentence saying read keys and MCP need `exposeApi` (or the HTTPRoute
  equivalent) when the agent runs outside the cluster.

Tests:

- One integration file per route under `tests/integration/read-api/`,
  seeded with `seedTestScenario` and a read key: tenancy (another org's id
  is 404), paging, each filter, and the scanner-key 403.
- A test that `GET /v1/images/:id/packages` on an image with 5 000
  components returns 100 rows and a `nextOffset`, since the cap is the
  rule everything downstream relies on.

Acceptance: with one read key and `curl`, a person can reproduce the
dashboard's "Fix these first" list, open one fix, list the findings it
clears, and find every running image carrying a named package, without the
browser and without the BFF.

### Phase 3: the MCP endpoint

Streamable HTTP MCP at `/v1/mcp`, in the server process, both editions and
both topologies. Label `enhancement`.

Dependencies and transport:

- `@modelcontextprotocol/sdk`, the 1.x line, pinned to the newest 1.x at
  implementation time (third-party guides in mid-2026 cite 1.29.0; the v2
  split packages are in beta and not for this). `McpServer` plus
  `StreamableHTTPServerTransport` from `server/streamableHttp.js`.
- **Stateless**: a transport per request with `sessionIdGenerator:
  undefined`, closed when the response ends. No session map, so the split
  topology's several API replicas need no affinity and nothing is held in
  memory between calls. `GET /v1/mcp` answers 405: the server pushes no
  notifications, and a stateless server may refuse the SSE stream.
- Authentication is the read key as a bearer header, through the same
  `requireAuth, requireScope('read'), readLimit` chain as phase 2, mounted
  before the transport. An unauthenticated call is the existing 401 with
  a `WWW-Authenticate: Bearer realm="stackradar"` header added so clients
  that look for it get a sensible message. No OAuth: self-hosters hand an
  agent a key, and the cloud's users do the same. That is an open question
  below, not a decision against OAuth forever.
- `MCP_ENABLED` (default `true`) as the kill switch, read in
  `config/index.ts` and listed in `AGENTS.md` § Environment Variables.
  When off the route is not mounted and `/api/edition` does not advertise it.

Code, `server/src/mcp/`:

- `server.ts` builds the `McpServer` (name `stackradar`, the package
  version) and registers the tools. Each tool handler receives `{ orgId,
  keyId }` from the request context and calls the same function the
  matching `/v1` controller calls, then returns the `/v1` shape as
  `structuredContent` plus a one-paragraph `text` summary (counts and the
  top three rows by name) for clients that only render text.
- `route.ts` is the Express handler: builds the transport, connects the
  server, hands over `req`/`res`. One `McpServer` per request is cheap and
  keeps tool registration free of global state.
- Tools, every one with `annotations: { readOnlyHint: true,
  destructiveHint: false, openWorldHint: false }` and an input schema in
  zod reusing the `/v1` query schemas:

| Tool | Calls | When an agent reaches for it |
|---|---|---|
| `list_fixes` | `/v1/fixes` | "What should I upgrade first?" The default entry point; the description says the list is ranked and that `measured: false` rows only prove a newer version exists. |
| `list_findings` | `/v1/findings` | "Show me the KEV findings in namespace X", "what is critical on this image". |
| `get_vulnerability` | `/v1/vulnerabilities/:vulnId` | "Are we exposed to CVE-2025-1974, where, and what fixes it?" |
| `find_images` | `/v1/images?search=` | Resolve `ghcr.io/foo/bar:1.2` from a manifest to an image id and its counts. |
| `get_image` | `/v1/images/:id` | The upgrade recommendation and where the image runs; the thing an agent needs before editing a tag. |
| `list_image_packages` | `/v1/images/:id/packages` | Paged; `vulnerable_only` defaults to true in the tool even though the route defaults to false, because an agent almost never wants the clean packages. |
| `find_package` | `/v1/packages` | "Do we run any image with `openssl` 3.0.x?" |
| `list_clusters` | `/v1/clusters` | Scoping, and the first call a client makes to prove the key works. |

Eight tools, named as verbs over the nouns the UI uses. No resources and no
prompts in this version: client support for both is uneven, and a tool
with a good description is what every client renders. Tool descriptions are
the product's own words (ADR 0005 and 0007 for what the score is, the
`measured` caveat from `FixListItem`'s doc comment) and say what the result
does not contain ("packages are not inlined; call `list_image_packages`").

Limits inside the tools, independent of the route's:

- `limit` capped at 50 per tool call (the route allows 100), default 20.
- A result over roughly 60 KB of JSON is truncated at a row boundary with
  `truncated: true` and a `nextOffset`, and the text summary says so.
- `list_image_packages` refuses `vulnerable_only: false` without an
  explicit `limit`, so a stray call cannot pull a base image's package list.

Client configuration, which the docs page carries verbatim:

```sh
claude mcp add --transport http stackradar https://stackradar.example.com/v1/mcp \
  --header "Authorization: Bearer srr_…"
```

and the JSON equivalents for Cursor and VS Code. For a client that only
speaks stdio, the page points at `mcp-remote` as the bridge; that is also
why phase 4 is deferred.

Deployment: the `/v1/mcp` path joins the hosted allow-list; ingress-nginx
needs no buffering change for stateless JSON responses. Add
`mcp_tool_calls_total{tool,outcome}` and a duration histogram to
`/metrics` next to the existing request metrics.

Tests, `tests/integration/mcp/`:

- Start `http.createServer(app)` on port 0 and drive it with the SDK's
  `Client` over `StreamableHTTPClientTransport`: `initialize`, `tools/list`
  (eight tools, all `readOnlyHint`), each tool once against
  `seedTestScenario` data with the same assertions as its `/v1` route.
- A scanner key gets 403 from `initialize`; no key gets 401 with the
  `WWW-Authenticate` header; `MCP_ENABLED=false` gets 404.
- The truncation rule on a seeded 5 000-component image.
- A unit test that every tool's input schema accepts exactly the parameters
  its `/v1` route accepts (same zod object), so a route filter added later
  shows up in the tool or fails CI.

Acceptance: from Claude Code in a GitOps repository, with the server's
`/v1` exposed and one read key, "what should I upgrade first in this
cluster and show me the diff" produces a `values.yaml` or manifest edit
with the chart version or tag from `list_fixes`, and the only server-side
traffic is `POST /v1/mcp` from that key.

### Phase 4 (deferred): `stackradar mcp` in the CLI

A stdio MCP server in `stackradar-cli` (`cmd/mcp.go`, the official Go SDK),
proxying the same eight tools to a server named by `STACKRADAR_URL` with a
read key in `STACKRADAR_TOKEN`. Build it only when a user reports a client
that cannot speak streamable HTTP and cannot run `mcp-remote`, or when
the CLI's own offline scan results (the `scan` command, `internal/report`)
are worth exposing locally, which is a different product question. Until
then the docs page names `mcp-remote` for stdio-only clients.

## Out of scope

- Any write through a key: acknowledging, ignoring, snoozing, triggering a
  rescan. Each is a later plan with its own scope string.
- Per-cluster read keys. A read key is org-wide; the community edition has
  one cluster anyway, and the cloud's per-cluster need has not been voiced.
- OAuth 2.1 for the MCP endpoint (open question below).
- SBOM document download through a key (`/api/sboms/:id/document` stays
  BFF-only). Add `GET /v1/images/:id/sbom` later if a CI consumer asks;
  it is the one route that cannot be compact.
- MCP resources, prompts, sampling, elicitation.
- Chart index (charts.stackradar.io) data. Its API is its own and public.
- Exposing `/api/search` as a tool. `find_images`, `find_package` and
  `get_vulnerability` cover the cases that matter; the palette's grouped
  ranking is a UI shape.

## Documentation to update with the change

- `docs/authorization-matrix.md`: a **Read key** row in Principals; a
  "Read keys and the read API" section with the mint, list, revoke rows and
  the `/v1` read routes; the Scanner row's "the `/v1` ingest surface only"
  wording.
- `docs/ARCHITECTURE.md` § 2.3 becomes "Machine clients → Express" with
  two subsections (scanner key, read key), and § 2.5's "only the per-key
  buckets on `/v1`" sentence gains the read bucket; § 10 Health gains
  `/v1/mcp`.
- `docs/contracts/read-api-v1.md` and `read-api-v1.openapi.yaml` (new).
- `docs/mcp.md` (new, both editions): what the tools answer, the client
  configuration block, the key, the `exposeApi` requirement, `mcp-remote`
  for stdio clients, and one worked example ending in a diff.
- `docs/self-hosting/README.md`: a row for `mcp.md` and a sentence in
  `helm.md` under Ingress about `exposeApi` for agents outside the cluster.
- `AGENTS.md` § Environment Variables: `MCP_ENABLED`.
- The hosted docs (`stackradar-landing/src/lib/docs.ts`): a "Read keys"
  section on the `api-keys` page and a new `mcp` page under Reference.
- `SECURITY.md` scope: read keys are credentials; a leak is a report.

## Open questions

- **One scope or several?** This plan says one `read`. Splitting into
  `findings:read` and `inventory:read` lets a key see fixes without
  package lists, which some security teams will ask for. The cost is a
  scope picker in the create dialog on day one. Decide before phase 1
  lands; adding scopes later is additive, removing one is not.
- **OAuth for `/v1/mcp`.** The MCP authorization spec describes OAuth 2.1
  with resource metadata, and some hosted clients prefer it. The cloud
  could become an OAuth resource server fronted by Auth.js later; the
  community edition should keep working with a pasted key regardless.
  Design the 401 so adding `WWW-Authenticate` resource metadata later is
  not a breaking change.
- **Cloud plan gating.** Nothing here is gated by plan. If read keys turn
  out to be the thing teams pay for, the gate belongs on key count, never
  on whether `/v1/mcp` exists.
- **Prefix format.** `srr_` is proposed for read keys; scanner keys keep
  the bare 32 characters. Changing scanner keys too would let both be
  secret-scanning patterns but means rolling every scanner Secret, which
  is a separate decision with the chart.
- **Listing.** Once phase 3 ships, submit to the MCP registry and the
  client marketplaces that list servers. That is marketing work and lives
  in the workspace's launch notes, not in this plan.
