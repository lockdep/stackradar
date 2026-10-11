# Self-hosting StackRadar

*Applies to: Community Edition. The cloud at app.stackradar.io runs the
same images from its own manifests; a cloud user installs only the
[scanner](https://github.com/lockdep/stackradar-scanner) and reads
[stackradar.io/docs](https://stackradar.io/docs) instead.*

The community edition is the dashboard for the cluster it runs in: the
server, the UI, a Postgres and the scanner, installed together. These pages
are its manual. Each one says at the top which edition it applies to.

| Page | When you need it |
|:--|:--|
| [helm.md](helm.md) | **Start here.** The real install: `helm install stackradar` on the cluster you want to see, the fixtures to replace before keeping it, Ingress, resources, the split topology, GitOps. |
| [docker-compose.md](docker-compose.md) | The laptop try-out without a cluster. Proves the platform with an SBOM you upload by hand. |
| [users-and-login.md](users-and-login.md) | The bootstrap admin, roles, creating local users, lockouts, and resetting an admin you are locked out of. |
| [oidc.md](oidc.md) | Signing in through Keycloak, Authentik, Microsoft Entra ID, Okta or any other OpenID Connect provider, and mapping a group to platform admin. |
| [own-postgres.md](own-postgres.md) | Pointing the install at a database you run (managed or not), and moving off the bundled one. |
| [upgrading.md](upgrading.md) | What to read before an upgrade, in which order; how migrations run; rolling back. |
| [backup.md](backup.md) | What to back up (one database, one encryption key), how, and how to prove the restore works. |

The chart's values reference is the
[chart README](https://github.com/lockdep/helm-charts/blob/main/charts/stackradar/README.md)
in `lockdep/helm-charts`; the Compose file documents itself in its header.
Questions go to [GitHub Discussions](https://github.com/lockdep/stackradar/discussions),
defects to [Issues](https://github.com/lockdep/stackradar/issues/new/choose).
