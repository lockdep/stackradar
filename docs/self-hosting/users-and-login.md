# Users and local login

*Applies to: Community Edition. On the cloud, accounts are GitHub, Google
or OIDC sign-ins and local passwords are off.*

A self-hosted install signs in with a username and password by default,
the way Dependency-Track, Grafana, Harbor and Argo CD do. Any OpenID
Connect provider, GitHub and Google can be added ([oidc.md](oidc.md)) and
the local form can then be switched off.

## The bootstrap admin

On its first start, when local login is on and **no account has a password
yet**, the client creates one local account:

| | Default | Where to change it |
|:--|:--|:--|
| Email | `admin@stackradar.local` | `auth.local.adminEmail` (chart) / `AUTH_BOOTSTRAP_ADMIN_EMAIL` (Compose) |
| Password | `admin` | `auth.local.adminPassword` (chart; or `secrets.existingSecret` with the `admin-password` key) / `AUTH_BOOTSTRAP_ADMIN_PASSWORD` (Compose) |

The password is used exactly once: the account is created with
*must change password* set, so the first login replaces it before anything
else loads. That is why the fixture default is acceptable where the other
fixture secrets are not; `make quickstart` in `deploy/compose/` leaves it
alone on purpose.

The server seeds one organisation, `default`, at start-up. **The first user
to sign in becomes its owner; everyone after is a member.** The bootstrap
admin is also a *platform admin* (the Admin area in the sidebar: users,
the OSV mirror and the other feeds, the job queue, the image and SBOM
explorer), which is a separate flag from the organisation role.

The seed is conservative: one local account anywhere means the install has
been bootstrapped and the bootstrap variables are never consulted again,
however they change later. An existing account at the bootstrap address
(someone who signed in with GitHub first) is left alone too.

## Roles

| Role | Scope | Can |
|:--|:--|:--|
| **Member** | the organisation | See everything: clusters, images, findings, fixes, the feed. Download SBOMs. |
| **Admin** | the organisation | Everything a member can, plus organisation settings: the alert webhook, the findings view defaults, inviting and removing members. |
| **Owner** | the organisation | Everything an admin can, plus deleting the organisation. The first user to sign in. |
| **Platform admin** | the install | The Admin area: local users and their passwords, the OSV mirror and the other feeds, the job queue, the image and SBOM explorer. Set per user, independent of the organisation role. |

[docs/authorization-matrix.md](../authorization-matrix.md) has one row per
decision the server makes, with the file that makes it.

## Creating users

Platform admins create local accounts from **Admin → Users → New local
user**: an email and a password (12 characters minimum). The new user
signs in with it and is asked to change it. Members join the organisation
automatically on first sign-in; there are no invite emails in the community
edition (email is a cloud integration), and none are needed.

From the same tab an admin can set a new password on any local account,
which also clears a lockout and signs the account out everywhere, and make
any account a platform admin or revoke it — whatever way it signs in. The
last platform admin cannot be revoked. In the community edition the tab
also shows each account's organisation role, with a link to the
organisation's Members tab where it is changed.

Users who sign in through an identity provider need no local account; see
[oidc.md](oidc.md) for making the members of a group platform admins
automatically.

## Lockouts and rate limits

Five failed sign-ins lock a local account for fifteen minutes; the
counter is on the account, so it holds across replicas. The sign-in
endpoint also rate-limits per source address, and that limit lives in the
client process, so with more than one client replica put a rate limit on
`POST /api/auth/local` at the ingress as well; the chart's `NOTES.txt`
reminds you when you scale the client.

## Locked out of the admin account

The install has no email to send a reset link with, so the reset is a
command inside the client container:

```sh
# Helm
kubectl -n stackradar exec deploy/stackradar-client -- \
  node scripts/admin-reset-password.mjs admin@stackradar.local

# Docker Compose
docker compose exec client node scripts/admin-reset-password.mjs admin@stackradar.local
```

It prints a random password once (or takes one with `--password <new>`),
sets *must change password*, clears any lockout and revokes every session
the account has. It only touches accounts that already sign in with a
password; `--create-local` adds a password to an account that only had a
provider, which is a new way into that account, so the flag has to be said
out loud. The script reads `DATABASE_URL` the way the app does and needs
nothing else.

## Switching the local form off

Once an identity provider works, hide the form:

```yaml
# chart
auth:
  local:
    enabled: false
```

or `AUTH_LOCAL_ENABLED=false` on the client under Compose. Existing local
accounts keep their passwords but cannot use them until it is switched
back on; the reset script still works, so an install that loses its IdP
can always get its admin back.
