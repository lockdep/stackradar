<p align="center">
  <img src=".github/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">StackRadar</h1>

<p align="center">
  The vulnerabilities on the images running in your Kubernetes cluster,<br>
  ranked by what to fix first, with the upgrade that fixes them.
</p>

<p align="center">
  <a href="https://github.com/lockdep/stackradar/releases/latest"><img src="https://img.shields.io/github/v/release/lockdep/stackradar?style=flat-square&label=Release" alt="Latest release"></a>
  <a href="https://github.com/lockdep/stackradar/actions/workflows/ci-test.yaml"><img src="https://img.shields.io/github/actions/workflow/status/lockdep/stackradar/ci-test.yaml?branch=main&style=flat-square&label=Tests" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-informational?style=flat-square" alt="License: AGPL-3.0"></a>
  <a href="https://artifacthub.io/packages/helm/lockdep/stackradar"><img src="https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/lockdep&style=flat-square" alt="Artifact Hub"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/lockdep/stackradar"><img src="https://api.scorecard.dev/projects/github.com/lockdep/stackradar/badge?style=flat-square" alt="OpenSSF Scorecard"></a>
</p>

<p align="center">
  <a href="https://demo.stackradar.io/demo/enter">Live demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/">Documentation</a> ·
  <a href="https://stackradar.io">Website</a> ·
  <a href="https://app.stackradar.io">Cloud</a>
</p>

---

A scanner tells you your cluster has four thousand CVEs. StackRadar tells
you which of them are on images that are running right now, which of those
are being exploited in the wild, and which chart version or image tag makes
them go away. When a new advisory is published, the dashboard already knows
which pods run it, without pulling or scanning anything again.

StackRadar is open source under AGPL-3.0. Self-host it with one
`helm install`, or use the hosted version at
[app.stackradar.io](https://app.stackradar.io).

![The StackRadar dashboard: critical, high, medium and low counts with their seven-day trend, and the Risk Score, vulnerability, container and package trends across the organisation](docs/images/dashboard.png)

## Features

- **Scans what runs, once.** A read-only agent watches the pods of the
  cluster it runs in, pulls each image once per digest and writes its SBOM
  with [Syft](https://github.com/anchore/syft). No scan Job per workload, no
  report objects in etcd.
- **Re-matches instead of re-scanning.** The server mirrors
  [OSV.dev](https://osv.dev), [EPSS](https://www.first.org/epss/) and the
  [CISA KEV catalogue](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
  locally and matches every stored SBOM again whenever the mirror changes.
- **Ranks by exploitability.** The Risk Score folds CVSS, EPSS and KEV into
  one number per finding and sums them per image, container, release and
  cluster. The top of every list is what to fix first.
- **Tells base image from application layer**, so a finding in your own
  code is not buried under the ones in `debian:bookworm`.
- **Knows how the image got there.** The Helm release that packaged a
  workload and the Argo CD application that delivers it are on the page, so
  the fix is a chart version and a `helm`, `argocd` or `kubectl` command.
- **Shows what changed.** A feed of advisories that landed on running
  images, containers that moved between digests, and the finding delta
  between them. New critical and KEV findings can go to a Slack webhook.
- **End-of-life verdicts** for base images, so a fix that cannot exist is
  not on the list.
- **CycloneDX in and out.** Upload an SBOM by hand, download the stored SBOM
  of any image.
- **Sign-in your way.** Local username and password, any OpenID Connect
  provider, GitHub or Google.
- **One Postgres, migrations on boot, no telemetry.**

### StackRadar and Trivy Operator

The question comes up first, so here is the short answer. StackRadar does
not do configuration audit, RBAC assessment or CIS benchmarks;
[Trivy Operator](https://github.com/aquasecurity/trivy-operator) does. The
two watch the same pods, write to different places and run side by side
without conflict.

| | StackRadar | Trivy Operator |
|:--|:--|:--|
| Vulnerabilities on the images that are running | Yes | Yes |
| A new advisory lands on a running image | Re-matched from the stored SBOM; no pull, no rescan | Found on the next scheduled rescan |
| Ranking | CVSS, EPSS and CISA KEV folded into one score, summed per image, release and cluster | Severity counts per report |
| Base image vs application layer | Separated on every finding | Not separated |
| How the image got there | Helm release and Argo CD application on the page; the fix is a chart version | Workload owner only |
| End-of-life base images | Verdict per finding, so an impossible fix is not on the list | No |
| Configuration audit, RBAC, CIS benchmarks, exposed secrets | No | Yes |
| Where the results live | One Postgres, with history | Report objects in etcd, latest only |
| Clusters per dashboard | One (Community Edition), many (Cloud) | One per operator |

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-dark.svg">
  <img alt="StackRadar topology: a read-only scanner in your cluster sends SBOMs and inventory to the server over a cluster-scoped key; the server mirrors OSV.dev, EPSS and CISA KEV locally and stores everything in one PostgreSQL; the browser reaches the client only." src="docs/images/how-it-works-light.svg" width="920">
</picture>

Three components, two of them in this repository, and in a self-hosted
install all of them run in your cluster from one chart. The **scanner**
reports one SBOM per image digest plus the full workload inventory over an
API key scoped to its cluster. The **server** stores the SBOMs, mirrors the
advisory feeds, matches components by package URL and ranks every finding.
The **client** is the dashboard and the only thing a browser talks to. One
PostgreSQL database carries both, and the advisory syncs are the only
traffic that leaves the cluster.

The image is the unit of identity, not the workload, and the score has two
layers: a 0–100 risk per finding that is a pure function of the advisory,
and an unbounded sum of those per rollup. The trust boundaries, the data
model and the decisions behind them are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the ADRs in
[docs/adr/](docs/adr/).

## Quick start

### Helm

Kubernetes 1.25+ and Helm 3.8+. No values file, no database to bring, and
the scanner is included:

```sh
helm install stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --create-namespace -n stackradar
kubectl -n stackradar port-forward svc/stackradar-client 3000:3000
```

Open <http://localhost:3000> and log in as `admin@stackradar.local` with the
password `admin`. Your cluster's images are already being scanned; findings
appear once the vulnerability mirror has bootstrapped. On a laptop cluster
(kind, minikube, Docker Desktop) add
`-f https://raw.githubusercontent.com/lockdep/helm-charts/main/charts/stackradar/values-quickstart.yaml`
for trimmed resources and a two-minute, Alpine-only mirror.

> [!WARNING]
> The default install uses a bundled Postgres and **public fixture
> credentials**. Set your own before you rely on it;
> [docs/self-hosting/helm.md](docs/self-hosting/helm.md) is the walkthrough.

### Docker Compose

The try-out without a cluster. It cannot run the scanner, so you upload an
SBOM yourself:

```sh
curl -LO https://raw.githubusercontent.com/lockdep/stackradar/main/deploy/compose/docker-compose.yml
docker compose up -d
```

[docs/self-hosting/docker-compose.md](docs/self-hosting/docker-compose.md)
has the upload commands and the same warning about fixture secrets.

### From your laptop

No install, no account: [`stackradar scan`](https://github.com/lockdep/stackradar-cli)
answers the same question for any cluster you have `kubectl` access to and
prints the report in your terminal.

## Community Edition and StackRadar Cloud

One codebase, two configurations. `STACKRADAR_EDITION=community` is the
default; the cloud opts in. Everything sold only on the cloud lives under
[`server/src/cloud/`](server/src/cloud/) and
[`client/src/cloud/`](client/src/cloud/), and CI keeps the boundary
mechanical.

| | Community Edition | StackRadar Cloud |
|:--|:--|:--|
| Runs | In your cluster, or on a laptop with Compose | app.stackradar.io; you install only the scanner |
| Clusters | One | Many, in one dashboard |
| Postgres and the advisory mirror | Yours | Ours |
| Sign-in | Local, OIDC, GitHub, Google | GitHub, Google, OIDC; enterprise SSO planned |
| Alerts | One Slack webhook per organisation | Email and Slack, with a weekly digest |
| Price | Free, AGPL-3.0 | Free for one cluster; see [pricing](https://stackradar.io/pricing) |

## Documentation

- [Self-hosting](docs/self-hosting/): Helm walkthrough, Compose, users and
  local login, OIDC, your own Postgres, upgrading, backups
- [Chart values reference](https://github.com/lockdep/helm-charts/blob/main/charts/stackradar/README.md)
- [Architecture](docs/ARCHITECTURE.md) and the [ADRs](docs/adr/)
- [Scanner wire contract](docs/contracts/) and the
  [authorization matrix](docs/authorization-matrix.md)
- [Developing](DEVELOPING.md), [releasing](RELEASING.md) and verifying a
  release's signature
- The hosted product: [stackradar.io/docs](https://stackradar.io/docs)

## Related repositories

| Repository | What it is | Licence |
|:--|:--|:--|
| [lockdep/stackradar](https://github.com/lockdep/stackradar) | This one: the server, the web client and the self-hosting docs | AGPL-3.0 |
| [lockdep/helm-charts](https://github.com/lockdep/helm-charts) | The `stackradar` chart: both apps, a bundled Postgres and the scanner | Apache-2.0 |
| [lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner) | The in-cluster agent, the only SBOM ingestion path | Apache-2.0 |
| [lockdep/stackradar-cli](https://github.com/lockdep/stackradar-cli) | `stackradar scan`, the same answer from a laptop | Apache-2.0 |

## Security

- **The agent is read-only.** `list` and `watch` on pods plus metadata-only
  `get` on their controllers. What leaves the cluster is an allowlist,
  documented in the [scanner README](https://github.com/lockdep/stackradar-scanner#what-leaves-your-cluster).
- **No telemetry.** The only outbound traffic from a self-hosted install is
  the advisory mirror syncs.
- **Cluster-scoped keys.** An SBOM and its findings belong to exactly one
  cluster; nothing derived from an upload is shared across clusters.
- **Signed, attested, multi-arch releases.** Images are signed with cosign
  keyless and carry SLSA provenance and SBOM attestations; the chart pins
  them by digest. [RELEASING.md](RELEASING.md) has the `cosign verify`
  commands.

Report a vulnerability privately through
[GitHub's private reporting](https://github.com/lockdep/stackradar/security/advisories/new)
or to security@stackradar.io. [SECURITY.md](SECURITY.md) has the scope,
the response time and the supported versions.

## Community

- Questions and ideas: [GitHub Discussions](https://github.com/lockdep/stackradar/discussions)
- Defects and enhancements: [GitHub Issues](https://github.com/lockdep/stackradar/issues)
- What is coming: the [next milestone](https://github.com/lockdep/stackradar/milestones),
  the issues labelled [`help wanted`](https://github.com/lockdep/stackradar/issues?q=is%3Aopen+label%3A%22help+wanted%22),
  and the design plans in [docs/plans/](docs/plans/)
- Using StackRadar? Add yourself to [ADOPTERS.md](ADOPTERS.md)

## Contributing

Contributions of every shape are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
says how to file an issue and send a pull request (commits are signed off
under the [DCO](https://developercertificate.org/); there is no CLA),
[DEVELOPING.md](DEVELOPING.md) says how to build and run the two apps, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is the Contributor Covenant.
Issues labelled [`good first issue`](https://github.com/lockdep/stackradar/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
are the ones to start with.

## Copyright & Licence

Copyright (C) 2026 LockDep.

This repository is licensed under the
[GNU Affero General Public License, version 3 only](LICENSE), except for
`server/src/cloud/` and `client/src/cloud/`, which are source-available
under the [StackRadar Cloud Licence](server/src/cloud/LICENSE). The scanner,
the CLI and the Helm chart are Apache-2.0. The licence covers the code, not
the name; [NOTICE](NOTICE) has the trademark terms.
