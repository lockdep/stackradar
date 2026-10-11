# Signing in with OpenID Connect

*Applies to: Community Edition. The cloud offers GitHub, Google and OIDC
sign-in from its own configuration; nothing here is needed there.*

Any OpenID Connect provider works: the client runs discovery from the
issuer URL and uses the authorization-code flow with PKCE. Three settings
make the provider exist; the rest are optional.

| Setting | Chart (`auth.oidc.*`) | Compose (client env) | What |
|:--|:--|:--|:--|
| Issuer | `issuer` | `AUTH_OIDC_ISSUER` | The URL whose `/.well-known/openid-configuration` the client fetches |
| Client id | `clientId` | `AUTH_OIDC_ID` | |
| Client secret | `clientSecret`, or `existingSecret.name` with the keys `client-id` and `client-secret` | `AUTH_OIDC_SECRET` | |
| Button label | `name` | `AUTH_OIDC_NAME` | Default "Single sign-on" |
| Scope | `scope` | `AUTH_OIDC_SCOPE` | Default `openid email profile`; add `groups` where the provider needs the scope to release the claim |
| Admin group | `adminGroup` | `AUTH_OIDC_ADMIN_GROUP` | Members of this group are platform admins, re-evaluated at every sign-in |
| Groups claim | `groupsClaim` | `AUTH_OIDC_GROUPS_CLAIM` | The claim that carries group membership; default `groups` |

**Callback (redirect) URL:** `<your external URL>/api/auth/callback/oidc`,
for example `https://stackradar.example.com/api/auth/callback/oidc`, or
`http://localhost:3000/api/auth/callback/oidc` under Compose. The external
URL is the chart's `externalUrl` (derived from the Ingress host when not
set) or the client's `AUTH_URL`.

A half-configured provider (an issuer without a secret, say) keeps the
client from reporting ready, on purpose, and `helm template` fails with
the name of the missing value. A configuration with no sign-in method at
all is refused the same way.

Accounts are matched on the email address the provider asserts. Someone
who first signed in with a password and then through the IdP with the same
email is the same user. The first user to sign in, by any method, becomes
the organisation's owner ([users-and-login.md](users-and-login.md)).

## Platform admins from a group

With `adminGroup` set, a user whose token carries that group in the groups
claim is a platform admin for the session, and loses it at the next
sign-in if the group is gone. Without it, platform admins are managed in
StackRadar only (the bootstrap admin, and whoever it promotes). With it,
the group is the source of truth: a promotion or demotion made in the
Users tab lasts until that user's next sign-in.

`AUTH_GITHUB_*` and `AUTH_GOOGLE_*` work the same way as the OIDC pair
minus the group mapping; `auth.github.*` and `auth.google.*` in the chart.

## Provider recipes

The values below are what differed between providers when these were
tested; everything else is the table above.

### Keycloak

1. In the realm, **Clients → Create client**: type OpenID Connect, client
   id `stackradar`, *Client authentication* on, *Standard flow* on, the
   callback URL as a valid redirect URI. Copy the secret from the
   *Credentials* tab.
2. Groups in the token: **Client scopes → `stackradar-dedicated` → Add
   mapper → By configuration → Group Membership**, token claim name
   `groups`, *Full group path* **off** (so the claim says `platform-admins`,
   not `/platform-admins`), *Add to ID token* on.
3. Issuer: `https://<keycloak>/realms/<realm>`.

### Authentik

1. **Applications → Create with provider**: an OAuth2/OpenID provider,
   *Confidential* client, the callback URL as a strict redirect URI, the
   `authentik default OAuth Mapping: OpenID 'profile'`, `'email'` and
   `'openid'` scopes selected.
2. Authentik releases groups in the `groups` claim through its default
   profile mapping, so no extra scope is needed; the group's name is what
   `adminGroup` matches.
3. Issuer: `https://<authentik>/application/o/<application-slug>/`
   (with the trailing slash; it is on the provider's overview page).

### Microsoft Entra ID

1. **App registrations → New registration**: a *Web* platform with the
   callback URL. Under *Certificates & secrets* create a client secret;
   under *API permissions* the default `User.Read` (delegated) is enough
   for `openid email profile`.
2. Groups in the token: **Token configuration → Add groups claim →
   Security groups**, emitted as *Group ID* (the default). Entra emits
   group **object ids**, not names, so `adminGroup` is the group's id
   (`00000000-0000-0000-0000-000000000000`). Users in more than 200 groups
   get an overage claim instead of the list; the mapping then does not
   apply, so keep the admin group small and consider *Groups assigned to
   the application* as the emitted set.
3. Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`. Single-
   tenant registrations only; the `common` endpoint is not an OIDC issuer.

### Okta, Zitadel and the rest

Any provider that publishes `/.well-known/openid-configuration` under its
issuer and supports the authorization-code flow works with the table
above. For Okta the issuer is the authorization server
(`https://<org>.okta.com/oauth2/default`) and groups need a *Groups claim*
filter on that server; for Zitadel add the `urn:zitadel:iam:org:project:roles`
scope and set `groupsClaim` to that claim if you map admins from project
roles. If you get a provider working that is not listed here, a pull
request adding its recipe is very welcome.

## When it does not work

* **`redirect_uri_mismatch`**, or the provider refusing the callback: the
  external URL and the registered redirect URI differ, often by scheme or
  trailing slash. `kubectl -n stackradar exec deploy/stackradar-client -- env | grep AUTH_URL`
  shows what the client thinks it is.
* **The button is missing:** one of the three required values is unset.
  `GET /api/health/ready` on the client says which.
* **Signed in but not an admin:** the group is not in the token. Decode
  the ID token at the provider (most have a token preview) and check the
  claim name against `groupsClaim` and the value against `adminGroup`,
  including Keycloak's leading slash and Entra's ids.
