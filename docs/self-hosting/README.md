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

## The administration page

A platform admin (the bootstrap admin, or an account mapped to one through
OIDC) has an **Administration** entry in the sidebar. Its **System** tab is
the first place to look when something is off or before asking for help: it
shows both images' versions, the edition and topology, every operator
setting with the value in force and whether the environment set it, which
sign-in methods are on, whether the server's and the client's schemas are
current for the running build, and which OSV ecosystems the mirror carries
against what `OSV_ECOSYSTEMS` asks for. The **Overview** tab is the
pipeline's health — scanner, inventory, SBOMs, queue, mirror and feeds, one
tile each — and the other tabs are the data behind it: images,
vulnerabilities, the matcher, jobs, and the accounts when local login is on.

Where a reading calls for a hand, the hand is on the same screen: retry a
failed job (or every job that is out of retries), run the OSV sync or a feed
now, rebuild the mirror if `OSV_ECOSYSTEMS` was widened, collect orphaned
images ahead of the nightly sweep, or rescan every image after a matcher
change. Each runs the same code the schedule runs, behind the same lock, so
a click can never overlap a scheduled run; it is refused while the same
action is already in progress. In the split topology the feed triggers
answer with the name of the CronJob to run instead.
