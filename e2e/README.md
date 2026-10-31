# End-to-end tests

Playwright over the real product: the Compose quickstart
([`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml))
on images built from this checkout, seeded the way a scanner would seed it,
driven through a browser. Nothing is mocked; what passes here is what a
`docker compose up` user gets.

```sh
cd e2e
pnpm install
pnpm exec playwright install chromium   # once
pnpm test                               # builds the images, starts the stack, seeds it, runs the suite
```

The first run builds `stackradar-server:local` and `stackradar-client:local`
(a few minutes) and starts the stack as Compose project `stackradar-e2e` on
ports of its own (UI 3200, API 8280, Postgres 5446), so it runs beside
`pnpm dev` and `scripts/fresh-local.sh`. The stack stays up afterwards; the
next `pnpm test` is seconds of `docker compose build` cache hits and the
tests. `pnpm stack:down` removes it, database included.

| Command                               | What it does                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm test`                           | The suite, headless. `pnpm test -- tests/auth.spec.ts` for one file     |
| `pnpm test:ui` / `pnpm test:headed`   | Playwright's UI mode / a visible browser                                |
| `pnpm report`                         | Open the last HTML report (`playwright-report/`)                        |
| `pnpm stack:up` / `stack:down`        | Build + start and wait until healthy / stop and delete, volume included |
| `pnpm stack:logs -- server`           | The containers' logs (`-- -f server` follows one)                       |
| `pnpm typecheck`, `pnpm format:check` | What the `e2e` workflow checks before running the suite                 |

## How a run is put together

1. **`src/global-setup.ts`** runs `scripts/stack.sh up` (unless `E2E_BASE_URL`
   points at a stack that is already running), waits for both readiness
   probes, then seeds the stack through the server's public API with the
   fixture scanner key: a heartbeat, an inventory report (`src/api.ts`) with
   two namespaces — a Deployment running `nginx:1.27-alpine`, and one
   running an image from a private registry the scanner could not pull,
   reported with a `registry_auth` failure — and the nginx image's SBOM from
   `server/tests/fixtures/`. The private image never gets an SBOM: it is
   what "Not scanned", the coverage strip and the registry banner are
   about. Every step is idempotent; a second upload of the same digest
   answers `409` and the first one stands.
2. **The `setup` project** (`src/auth.setup.ts`) signs the bootstrap admin
   in. On a fresh database that is the forced password change
   (`admin` → the suite's own password); on a database that has seen the
   suite it is a plain sign-in. The browser state lands in `.auth/admin.json`.
3. **The `chromium` project** runs `tests/*.spec.ts` in parallel, each
   starting from that signed-in state and reading only. Tests that need to
   be signed out say so with `test.use({ storageState: { cookies: [], origins: [] } })`.
4. **The `stateful` project** runs `tests/stateful/mutations.spec.ts` after
   the `chromium` project has finished: a second inventory report that
   drops a container and one that brings it back, a cluster and an
   organisation rename, a second local account created from the admin's
   Users tab and signed in as. Everything in one file, serially, and each
   test puts back what it changed.
5. **`src/global-teardown.ts`** removes the stack only when `E2E_TEARDOWN=1`
   (the CI workflow does its own teardown step instead).

The stack is three Compose files: the quickstart, `dev/local-build.yml`
(images from the checkout, ports off the development ones) and
[`compose.e2e.yml`](compose.e2e.yml), which adds only a project name, a
40 MB `Alpine` mirror in place of the 1.2 GB default, no Artifact Hub
mirror and no restart policy.

## Writing a test

- **Select by role and label**, as a user would: `getByRole('heading', { level: 1, name: 'Images' })`,
  `getByLabel('Password', { exact: true })`. The app has no `data-testid`s
  and the suite does not add any; a selector that needs one is a sign the
  page is missing an accessible name.
- **Assert facts, not counts that drift.** The nginx image is listed; the
  advisory list is not empty once the mirror is live. How many findings an
  Alpine image has changes weekly and is not what the test is for.
- **Stay re-runnable.** The stack is kept between local runs, so a test that
  changes state goes in `tests/stateful/` and leaves the stack as it found
  it, or is idempotent (the seed). A test that needs a fresh database
  belongs in `auth.setup.ts`'s fresh branch, which is the only place one is
  guaranteed.
- **Record a defect, don't hide it.** A test that fails because the product
  is wrong stays as written and is marked `test.fixme(true, '<why>')` with
  the cause in a comment above it (`auth.spec.ts`, `inventory.spec.ts`,
  `coverage.spec.ts` carry the current three), so the suite is green and
  the defect is on record until it is fixed.
- **One browser.** Chromium only; the suite checks the product, not browser
  compatibility.

## Environment

| Variable                                       | Default                      | Meaning                                                                 |
| ---------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `E2E_UI_PORT` / `E2E_API_PORT` / `E2E_DB_PORT` | `3200` / `8280` / `5446`     | The stack's host ports                                                  |
| `E2E_BASE_URL` / `E2E_API_URL`                 | derived from the ports       | Run against a stack you started yourself; nothing is started or stopped |
| `E2E_SKIP_BUILD`                               | unset                        | `1`: `stack.sh up` skips `docker compose build`                         |
| `E2E_TEARDOWN`                                 | unset                        | `1`: global teardown runs `stack.sh down`                               |
| `E2E_OSV_ECOSYSTEMS`                           | `Alpine`                     | The mirror the stack bootstraps                                         |
| `E2E_ADMIN_PASSWORD`                           | the suite's own              | What the forced change sets the admin password to                       |
| `E2E_SCANNER_KEY`                              | the quickstart's fixture key | The cluster-scoped key the seed uploads with                            |

## Why Compose and not a cluster

The scanner is a Kubernetes agent and this suite does not run it: the
server and client are what this repository ships, the scanner has its own
repository and tests, and the wire format between them is a contract
([`docs/contracts/inventory-v3.md`](../docs/contracts/inventory-v3.md))
that the seed speaks directly. A kind or minikube job with the Helm chart
would prove the chart and the agent's RBAC, which is worth a separate,
slower workflow; it would not make these tests see more of the product.
