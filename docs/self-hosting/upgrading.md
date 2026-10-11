# Upgrading

*Applies to: Community Edition. The cloud is upgraded by its operators.*

An upgrade is a new pair of images, and sometimes a new chart. Both apps
apply their own schema migrations when they start, so the mechanics are
short; the reading before it is what keeps a self-hosted install out of
trouble.

## Read, in this order

1. **This guide**, for the procedure: it changes rarely.
2. **The [release notes](https://github.com/lockdep/stackradar/releases)
   of every version you skip past**, not just the target one. Each
   release says whether it carries a migration, whether anything is
   breaking (`Breaking Changes 🚨` at the top), and what a self-hoster has
   to do by hand, if anything. A migration that works on a populated
   database is a release rule, so "has to do by hand" is rare and is
   always written down.
3. **The chart's [UPGRADING.md](https://github.com/lockdep/helm-charts/blob/main/charts/stackradar/UPGRADING.md)**,
   for chart-level changes: renamed values, new defaults, a removed
   component. The chart's version is decoupled from the application's;
   `helm upgrade --dry-run` shows the chart's notes before anything
   applies.

Then take a backup ([backup.md](backup.md)). Not because upgrades fail
often, but because a dump taken before the migration is the only rollback
that exists: migrations are forward-only.

## Versions and tags

Server and client ship together under one version; the chart's
`appVersion` names the pair it was tested with and its `image.tag`
defaults to it. Image tags: `:<version>` is immutable, `:<major>.<minor>`
follows the newest patch of that minor, `:latest` is the newest release,
`:snapshot` is `main`. Pin a version in production and move it on
purpose. A tag from an application major the chart does not support fails
the render rather than the pods. Every release is signed; the
[release notes](https://github.com/lockdep/stackradar/releases) carry the
image digests and the `cosign verify` command, and say whether the
release applies schema migrations.

## Helm

```sh
helm repo update   # or nothing, for OCI
helm upgrade stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --namespace stackradar -f my-values.yaml --version <chart version>
```

Always with the same values file. A `helm upgrade` with no value changes
changes nothing: no Secret is rewritten, no key rotates. To move the
application without a new chart, set `server.image.tag` and
`client.image.tag` to the same version in the values (or `--set`). They
ship together under one number; do not mix them.

What happens next: the new server and client pods start, each takes the
Postgres advisory lock, one applies its chain, the rest wait and find
nothing to do, and the readiness probes gate the rollout. The old pods
keep serving until the new ones are ready. With `initializer.enabled`,
the migrations run in the `pre-upgrade` hook Jobs instead and the pods
skip them; Argo CD runs those as `PreSync` on every sync, which is safe
because a current database is a no-op.

Skipping versions is fine: the chain is the chain, and every migration is
applied in order from wherever the journal stopped.

## Docker Compose

```sh
docker compose pull
docker compose up -d
```

or with a pinned tag, `STACKRADAR_TAG=1.2.0 docker compose up -d`. The
same migrations run at start-up; `docker compose logs server` shows them.

## Rolling back

A release that has not run a migration rolls back by setting the previous
tag: images are immutable, so the previous version is exactly what ran
before. A release that **has** migrated does not: restore the dump you
took first into an empty database (or the same one, dropped and
recreated), then set the previous tag. The release notes say which
releases carry a migration, which is why they are read first.

## Postgres major upgrades

The bundled Postgres is not upgraded across major versions by the chart;
`postgresql.image.tag` pins it and a bump would not convert the data
directory. When a major becomes necessary, dump, recreate the volume on
the new major, restore ([own-postgres.md](own-postgres.md) has the
commands), or take the opportunity to move to a database you manage.
