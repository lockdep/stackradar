# Monorepo with pnpm workspaces

**Status:** Amended 2026-08-19 — the workspace half was never built; what stands is one repository of independent pnpm projects.
**Date:** 2026-06-30

**How it was amended.** The pnpm-workspaces half of this decision was never
realised: there is no root `package.json` and no `pnpm-workspace.yaml`. What
actually exists is the single-repository half — one git repo containing
**independent** pnpm projects (`server/`, `client/`), each its own workspace
root with its own lockfile, so every `pnpm` command runs inside the app
directory. Cross-cutting changes (e.g. the BFF↔server contract) still land in
one place, but nothing is hoisted or shared: dependencies are installed, built
and deployed per app. The marketing site that was the third app at the time
of the original decision has since moved to its own repository.

Original decision, kept for the record:

StackRadar is a single repository containing its deployable apps (`server`, `client`, and at the time a marketing site) managed as pnpm workspaces, rather than separate repos. This keeps shared types and cross-cutting changes (e.g. the BFF↔server contract) in one place at the cost of coupling their release cadence.
