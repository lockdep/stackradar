# StackRadar

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-informational?style=flat-square)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/lockdep/stackradar?style=flat-square&label=Release)](https://github.com/lockdep/stackradar/releases/latest)
[![Tests](https://img.shields.io/github/actions/workflow/status/lockdep/stackradar/ci-test.yaml?branch=main&style=flat-square&label=Tests)](https://github.com/lockdep/stackradar/actions/workflows/ci-test.yaml)
[![Helm chart](https://img.shields.io/badge/Helm-lockdep%2Fhelm--charts-informational?style=flat-square)](https://github.com/lockdep/helm-charts)
[![Discussions](https://img.shields.io/badge/Discussions-ask%20a%20question-informational?style=flat-square)](https://github.com/lockdep/stackradar/discussions)

See every known vulnerability on the images actually running in your
Kubernetes cluster, ranked by what to fix first. Self-hosted, or at
[app.stackradar.io](https://app.stackradar.io).

A scanner agent in the cluster generates a CycloneDX SBOM for every image
that runs and reports which namespace, workload, Helm release and Argo CD
application it runs in. The server keeps its own mirror of
[OSV.dev](https://osv.dev), [EPSS](https://www.first.org/epss/) and the
[CISA KEV catalogue](https://www.cisa.gov/known-exploited-vulnerabilities-catalog),
matches every SBOM against it, re-matches when the mirror changes, and
scores each finding by how likely it is to be exploited rather than by
CVSS alone. The dashboard answers "which pods run a new CVE" the moment the
advisory is published.

![The StackRadar dashboard: critical, high, medium and low counts with 30-day trends, and the running images that picked up new vulnerabilities](docs/images/dashboard.png)

## Features

* **Scans what runs, not what was built.** An event-driven agent watches the
  cluster's pods, pulls each image once per digest and generates its SBOM
  with [Syft](https://github.com/anchore/syft). One image in five
  namespaces is one pull, one SBOM and one matching pass.
* **Inventory with its delivery context.** Namespaces, workloads and
  containers, plus the Helm release that packaged a workload and the Argo CD
  application that delivers it: the chart version a CVE report cites and
  the place the fix is made are both on the page.
* **Your own vulnerability data.** The server mirrors OSV.dev for the
  ecosystems you choose, plus EPSS and KEV, and rebuilds the matches when
  the mirror changes. Nothing is sent anywhere to be scored.
* **Ranked by exploitability.** The Radar Score folds CVSS, EPSS and KEV
  into one number per finding and sums them per image, container, release
  and cluster, so the top of every list is what to fix first.
* **Fixes, not just findings.** Which tag or chart version to move to and
  what it removes, the `helm`, `argocd` or `kubectl` command that does it,
  end-of-life verdicts for base images, and an issue lifecycle whose
  "verified" state is written by the next scan, never by hand.
* **Base image versus your code.** Findings are split between the base
  image and the application layers, because most of them are in the base
  image and a rebuild on a newer base removes them all at once.
* **A feed of changes, not inventory.** New vulnerabilities on running
  images, containers that moved between digests with the finding delta
  between them, and scans whose results changed because the world did.
* **Sign-in that fits a self-hosted tool.** Local username and password with
  a bootstrap admin, any OpenID Connect provider, GitHub and Google.
* **Alerts on a Slack webhook** for new critical and KEV findings on
  running images, per organisation.
* **CycloneDX in and out.** Upload an SBOM by hand with `curl`; download
  the stored SBOM of any image.
* **One Postgres, migrations on boot, no telemetry.** The images never
  phone home; adoption is counted in pulls, issues and
  [ADOPTERS.md](ADOPTERS.md).

## Quickstart (Helm)

One command on any Kubernetes 1.25+ cluster. No values file, no database to
bring, no second command for the scanner:

```sh
helm install stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --create-namespace -n stackradar
kubectl -n stackradar port-forward svc/stackradar-client 3000:3000
```

Open <http://localhost:3000>, log in as `admin@stackradar.local` with the
password `admin`, and change it when asked. Your cluster's images are
already being scanned; they appear with findings once the vulnerability
mirror has bootstrapped (minutes, depending on your connection; the UI says
so until then). On a laptop cluster (kind, minikube, Docker Desktop) add
`-f https://raw.githubusercontent.com/lockdep/helm-charts/main/charts/stackradar/values-quickstart.yaml`
for trimmed resources and a two-minute, Alpine-only mirror.

> [!WARNING]
> The default install uses a bundled single-node Postgres and **public
> fixture credentials**: the database password, the service key, the
> encryption key, the session secret and the scanner's bootstrap key are
> the same on every install that leaves them at their defaults, and
> `helm install` prints a WARNING naming each one still in effect. Before
> relying on the install, set your own passwords and bootstrap key, or point
> it at your own database. The chart never generates a secret for you.
> [docs/self-hosting/helm.md](docs/self-hosting/helm.md) is the walkthrough.

## Quickstart (Docker Compose)

The try-out without a cluster. It cannot run the scanner, so it proves the
platform with an SBOM you upload yourself:

```sh
curl -LO https://raw.githubusercontent.com/lockdep/stackradar/main/deploy/compose/docker-compose.yml
docker compose up -d
```

Open <http://localhost:3000> and log in with the same default credentials.
[docs/self-hosting/docker-compose.md](docs/self-hosting/docker-compose.md)
has the two `curl` lines that upload an SBOM, and the same warning about
fixture secrets: keep it on your machine, or run `make quickstart` from
`deploy/compose/` in a checkout to rotate them before the first start.

## Community Edition vs StackRadar Cloud

One codebase, two configurations. The cloud at app.stackradar.io and a
self-hosted install run the same images; `STACKRADAR_EDITION=community` is
the default, and the cloud opts in. There is no fork and no feature flag
you cannot read in [`server/src/edition.ts`](server/src/edition.ts).

| | Community Edition | StackRadar Cloud |
|:--|:--|:--|
| Where it runs | Your cluster (`helm install stackradar`), or a laptop (Compose) | app.stackradar.io; you install only the scanner, with a key from the dashboard |
| Clusters | One: the cluster it runs in | Many in one dashboard, across networks and accounts |
| Postgres and the vulnerability mirror | You run them (a bundled Postgres by default) | We do |
| Sign-in | Local username/password, any OIDC provider, GitHub, Google | GitHub, Google and OIDC; enterprise SSO (SAML, SCIM, enforced SSO) is planned for the cloud only |
| Alerts | One Slack webhook per organisation | Email and Slack, with a weekly digest |
| Help | [Discussions](https://github.com/lockdep/stackradar/discussions) and issues | Support |
| Install command | `helm install stackradar …` | `helm install stackradar-scanner …` with a key |
| Price | Free. AGPL-3.0 | Free for one cluster; Pro and Business from $59 and $199 a month. See [stackradar.io/pricing](https://stackradar.io/pricing) |

Everything that is only sold on the cloud lives under
[`server/src/cloud/`](server/src/cloud/) and
[`client/src/cloud/`](client/src/cloud/), under its own licence (below),
and is mounted by one line when the edition is cloud. A contributor can see
where the boundary is, and CI ([cloud-boundary.yaml](.github/workflows/cloud-boundary.yaml))
keeps it mechanical.

## Distributions

Two images, built from this repository and released together under one
version:

| Image | What it is |
|:--|:--|
| `ghcr.io/lockdep/stackradar-server` | The API, the job worker and the OSV / EPSS / KEV sync schedule. In the default `monolith` topology all three run in one process. |
| `ghcr.io/lockdep/stackradar-client` | The web UI (Next.js), which also keeps its Auth.js tables in the `auth` schema of the same database. |

Tags: `:<version>` is immutable, `:latest` is the newest release, `:snapshot`
is the last merge to `main` ([`dev/docker-compose.yml`](dev/docker-compose.yml)
runs that one). Images are signed with Cosign (keyless) from the build
workflow. The scanner agent is a separate image and chart from
[lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner).

## Deploying on Kubernetes with Helm

The chart lives in [lockdep/helm-charts](https://github.com/lockdep/helm-charts)
(`charts/stackradar`); its README is the values reference and
[docs/self-hosting/helm.md](docs/self-hosting/helm.md) is the walkthrough.
The rest of [docs/self-hosting/](docs/self-hosting/) covers users and
local login, OIDC, moving to your own Postgres, upgrading and backups.

## Contributing

Interested in contributing to StackRadar? [CONTRIBUTING.md](CONTRIBUTING.md)
says how to ask, file, and send code; [DEVELOPING.md](DEVELOPING.md) says how
to build and run it.

## Resources

* Self-hosting: [docs/self-hosting/](docs/self-hosting/)
* Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the ADRs in [docs/adr/](docs/adr/)
* Who runs it: [ADOPTERS.md](ADOPTERS.md)
* Website: <https://stackradar.io>

## Community

* Questions and ideas: [GitHub Discussions](https://github.com/lockdep/stackradar/discussions)
* Defects and enhancements: [GitHub Issues](https://github.com/lockdep/stackradar/issues)
* Security reports: [SECURITY.md](SECURITY.md)

## Copyright & Licence

StackRadar is Copyright (C) 2026 LockDep. All rights reserved.

The code in this repository is licensed under the
[GNU Affero General Public License, version 3 only](LICENSE), with one
exception: the files under `server/src/cloud/` and `client/src/cloud/` are
source-available under the [StackRadar Cloud Licence](server/src/cloud/LICENSE),
which allows anything except offering them as a hosted or managed service.
The scanner agent is Apache-2.0. The licence covers the code, not the name;
see [NOTICE](NOTICE) for the trademark terms.
