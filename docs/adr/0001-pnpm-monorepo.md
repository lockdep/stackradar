# Monorepo with pnpm workspaces

**Status: amended (2026-08-19).** The pnpm-workspaces half of this decision
was never realised: there is no root `package.json` and no
`pnpm-workspace.yaml`. What actually exists is the single-repository half —
one git repo containing three **independent** pnpm projects (`server`,
`client`, `landing-page`), each its own workspace root with its own lockfile.
Cross-cutting changes (e.g. the BFF↔server contract) still land in one place,
but nothing is hoisted or shared: dependencies are installed, built and
deployed per app.

Original decision, kept for the record:

StackRadar is a single repository containing three deployable apps (`server`, `client`, `landing-page`) managed as pnpm workspaces, rather than separate repos. This keeps shared types and cross-cutting changes (e.g. the BFF↔server contract) in one place at the cost of coupling their release cadence.
