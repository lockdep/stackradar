# BFF proxies to Express with an internal service key

The browser never calls the Express server directly for authenticated traffic. Instead the Next.js client exposes BFF API routes that authenticate the user (Auth.js session) and proxy to Express, attaching a shared `INTERNAL_SERVICE_KEY` header so Express can trust the caller is the BFF and not the public internet.

## Consequences

- Express trusts the `INTERNAL_SERVICE_KEY` for BFF traffic; the key must match between client and server deployments and must never be exposed to the browser.
- The StackRadar scanner agent is the deliberate exception — running inside a customer's Kubernetes cluster, it bypasses the BFF and calls Express directly on `/v1/*` with a cluster-scoped API key (see `client/docs/adr/`).