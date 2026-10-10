# Runbook: miscellaneous operations

## DigitalOcean container registry

```bash
doctl registry login
```

## Scanner behind a TLS-intercepting proxy (CA errors)

Do not disable certificate verification. Give the agent the CA instead —
`caBundle.configMapName` in the chart; see "Behind a TLS-intercepting proxy"
in `stackradar-scanner/helm/README.md`.

```bash
kubectl create configmap stackradar-ca -n stackradar-scanner \
  --from-file=ca-certificates.crt=/path/to/your-ca.crt

helm upgrade stackradar-scanner ... --reuse-values \
  --set caBundle.configMapName=stackradar-ca
```

## Stripe webhooks in local development

```bash
stripe login
stripe listen --forward-to localhost:8080/v1/webhooks/stripe
```

Then update `STRIPE_WEBHOOK_SECRET` in `server/.env`.

## Transactional email (Resend)

The server sends org invite and welcome emails through [Resend](https://resend.com)
(`server/src/services/email.service.ts`) and receives delivery events on
`POST /v1/webhooks/resend` (Svix-signed, see `server/src/lib/resend-webhook.ts`).
Delivery state lands on `org_invites.email_status`.

Env (server):

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Unset = email disabled; invites are still created and `inviteUrl` is returned for sharing by hand. |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` from the Resend dashboard → Webhooks. Unset = webhook answers 401. |
| `EMAIL_FROM` | Sender. Use a dedicated transactional subdomain (`mail.stackradar.io`) so marketing mail never shares its reputation. Default `StackRadar <no-reply@mail.stackradar.io>`. |
| `EMAIL_REPLY_TO` | Optional — but the welcome email says "reply to this email", so set it to a monitored mailbox. |
| `SITE_URL` | Marketing site, for docs links in emails. Default `https://stackradar.io`. |
| `PUBLIC_API_URL` | The browser-reachable API host (`https://api.stackradar.io`). The digest's and the alerts' unsubscribe links point here; unset, they point at `localhost:8080`. Set in the overlay's `server-config`. |
| `DIGEST_UNSUBSCRIBE_SECRET` | HMAC key for those links (`server/src/lib/unsubscribe-token.ts`). Falls back to `INTERNAL_SERVICE_KEY`. |

One-time setup per environment:

1. Resend → Domains: add `mail.stackradar.io`, create the SPF/DKIM
   records it lists, wait for "Verified". DMARC is ours, not Resend's:
   `_dmarc.stackradar.io TXT "v=DMARC1; p=none; rua=mailto:contact@stackradar.io"`
   (in place since 2026-09-26; move to `p=quarantine` once the reports show
   only our mail). Check with `doctl compute domain records list stackradar.io`
   — the authoritative answer — rather than `dig`, which has returned empty
   TXT answers from some networks.
1. The API ingress must expose `/v1/digest/unsubscribe` and
   `/v1/alerts/unsubscribe` (GET and POST): every notification mail links to
   them and carries the RFC 8058 one-click headers pointing at them.
2. Resend → API Keys: create a *sending-only* key restricted to that domain.
   Put it in `server-secrets` as `RESEND_API_KEY`.
3. Resend → Webhooks: add `https://api.stackradar.io/v1/webhooks/resend` with
   events `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`. Put its signing secret in `server-secrets` as
   `RESEND_WEBHOOK_SECRET`. The ingress already allow-lists the path.
4. `scripts/set-resend-secrets.sh prod` (or `dev`) — prompts for both values,
   patches `server-secrets` and restarts server + worker.

Local development: leave `RESEND_API_KEY` unset (invites log a warning and
return `emailStatus: "not_configured"`), or set a key and use the Resend
dashboard's test addresses (`delivered@resend.dev`, `bounced@resend.dev`).

## Ingest rate limits and API replicas

Per-key token buckets guard `POST /v1/sboms/upload/cyclonedx` (60 burst,
30/min sustained) and `POST /v1/inventory` (5 burst, 2/min) — see
`server/src/middleware/rate-limit.ts`. The buckets are **in-memory per
process**: with N API replicas the effective limit is N× the configured one,
which still bounds abuse. If the API ever scales past a couple of replicas,
move the buckets to Postgres or Redis. Unauthenticated flood protection is
the ingress `limit-rps` annotation, not the app.
