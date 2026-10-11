# Releasing StackRadar

How a version of the server and client ships, modelled on
[Dependency-Track's release process](https://github.com/DependencyTrack/dependency-track/blob/master/RELEASING.md):
one workflow run tags a version, a second one builds, signs and publishes
it, and a short checklist on either side keeps self-hosters out of trouble.
The scanner agent has its own, in
[lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner/blob/main/RELEASING.md);
the Helm chart has its own in
[lockdep/helm-charts](https://github.com/lockdep/helm-charts).

## Versioning

- **One version for server and client.** They ship together, so both
  `package.json` files carry the same number and the two images are tagged
  with it. SemVer: a breaking change for someone running the images (a
  removed environment variable, a changed default, an API a scanner
  depends on) is a major; new capability is a minor; fixes are a patch.
  While on `0.x`, breaking changes go in the minor position.
- **`main` is always the next minor**, as `x.y.0-snapshot` in both
  `package.json` files. The `:snapshot` images are built from it on every
  merge.
- **A release branch `x.y.x` exists only when an older minor needs a
  bugfix.** It is created from the release tag, and the release workflow
  run on it refuses any version outside that minor.
- **The chart has its own version.** Its `appVersion` names the app release
  it was tested with and is what `helm install` runs by default; a chart
  release follows an app release when the app release carries a migration
  or a breaking change (post-release checklist below). The chart refuses
  to render an image tag from an app major it does not support.

What a release of `1.2.3` produces:

| Artifact | Where |
|:--|:--|
| `ghcr.io/lockdep/stackradar-server:1.2.3`, `ghcr.io/lockdep/stackradar-client:1.2.3` | Immutable, `linux/amd64` + `linux/arm64`, signed with cosign (keyless), SLSA provenance and SPDX SBOM attestations in the image index |
| `:1.2` | Moves to the newest `1.2.z` |
| `:latest` | Moves to the newest stable version overall; never to a prerelease or to a bugfix of an older minor |
| GitHub Release `v1.2.3` | Notes from the merged pull requests' labels ([`.github/release.yml`](.github/release.yml)) under a header with the image digests, the `cosign verify` command, and whether the release carries schema migrations; `checksums.txt` and a CycloneDX SBOM of each image attached |

The version dropdown in the
[defect template](.github/ISSUE_TEMPLATE/defect-report.yml) gains the new
version in the same commit that sets it.

## Pre-release checklist

- [ ] `main` (or the release branch) is green: the Tests workflow on the
      commit to be released passed. The release workflow runs it again
      regardless; this is to avoid burning a run on a known-red commit.
- [ ] Every pull request since the last release carries one of the labels
      [`release.yml`](.github/release.yml) categorises by: `breaking change`,
      `enhancement`, `defect`, `dependencies`. The pull request titles are
      the release notes, so they read as a line a self-hoster understands,
      and a pull request that carries a migration or needs a manual step
      says so in its title.
- [ ] **No pending migration that has not run against a copy of the
      production database.** The cloud is the oldest populated install and
      the best proxy for a self-hoster who installed at the first version.
      A migration that only works on an empty database is a defect, not a
      release. Recipe below.
- [ ] If the release carries a migration or a breaking change: the chart
      bump is prepared in `lockdep/helm-charts` (`appVersion`, chart
      `version`, the `artifacthub.io/images` annotation, a line in
      `UPGRADING.md` if values changed) so it can be released right after.
- [ ] [`docs/self-hosting/`](docs/self-hosting/) reflects any behaviour
      the release changes; every page says which edition it applies to.

### Rehearsing the migrations against a copy of production

The client's `auth` schema lives in the same database as the server's
tables, so one dump covers both migration chains. Everything in the dump is
customer data: keep it on an encrypted disk, never in the repository, and
delete it when done.

```sh
# 1. Open a connection to the production database the way your provider
#    documents (a tunnel or proxy; here it forwards to 127.0.0.1:5433). Then dump it with the
#    Postgres 18 client from the repo's dev Compose file, so pg_dump and the
#    server agree on their major:
docker compose up -d postgres
docker compose exec postgres pg_dump \
  "postgresql://USER:PASSWORD@host.docker.internal:5433/DATABASE?sslmode=require" \
  --format=custom --no-owner --no-privileges -f /tmp/rehearsal.dump

# 2. Restore it into a throwaway database on that same local Postgres (5444).
docker compose exec postgres createdb -U postgres rehearsal
docker compose exec postgres pg_restore -U postgres -d rehearsal \
  --no-owner --no-privileges /tmp/rehearsal.dump

# 3. Apply both chains from the commit you are about to release, the way a
#    self-hosted install does at boot. Both must finish without a manual step.
export DATABASE_URL='postgres://postgres:postgres@localhost:5444/rehearsal?sslmode=prefer'
pnpm --dir server db:migrate
pnpm --dir client db:migrate

# 4. Boot the server and client against it (DEVELOPING.md "Running") and
#    open the dashboard, an image page and the vulnerabilities page: a
#    migration that applies but leaves a page 500ing is the same defect.

# 5. Clean up.
docker compose exec postgres dropdb -U postgres rehearsal
docker compose exec postgres rm /tmp/rehearsal.dump
```

## Releasing

### A new minor from `main`

Actions → **Release** → *Run workflow* with `main` selected. Leave the
version empty to release what `package.json` says (`0.2.0-snapshot`
releases `0.2.0`), or type one to override it. From a terminal:

```sh
gh workflow run release.yaml --ref main
gh workflow run release.yaml --ref main -f version=0.3.0
```

### A bugfix of an older minor

Create the release branch from the tag once, land the fix on it (cherry-pick
or pull request against the branch), then run the same workflow with the
branch selected. The branch's version must belong to it: `0.2.x` releases
`0.2.1`, `0.2.2`, … and nothing else.

```sh
git checkout -b 0.2.x v0.2.0 && git push -u origin 0.2.x
# land the fix, then:
gh workflow run release.yaml --ref 0.2.x
```

### A prerelease

Pass a version with a prerelease suffix: `-f version=0.3.0-rc.1`. It
publishes `:0.3.0-rc.1` and nothing else (no `:0.3`, no `:latest`), the
GitHub Release is flagged as a prerelease, and the branch keeps its
snapshot version, so the stable release that follows gets the number. A
prerelease is not promoted to production and is not added to the defect
template's dropdown.

### What the two workflows do

[`release.yaml`](.github/workflows/release.yaml), on the branch you picked:

1. runs the whole Tests workflow on that commit (both suites, lint, the
   drift gates); nothing is tagged if it fails;
2. works out the version, refuses a tag that already exists, and on a
   release branch refuses a version from another minor;
3. stamps the version into both `package.json` files and the defect
   template with [`scripts/release-set-version.mjs`](scripts/release-set-version.mjs),
   commits (`prepare-release: set version to 0.2.0`, DCO-signed as
   `github-actions[bot]`) and pushes the branch, then tags `v0.2.0` and
   pushes the tag. The branch is pushed first: if someone landed a commit
   meanwhile the push is rejected, nothing has been tagged, and re-running
   is free;
4. drafts the GitHub Release with notes generated from the pull requests'
   labels;
5. starts `publish.yaml` on the tag (a tag pushed with `GITHUB_TOKEN`
   raises no push event, so it has to be started explicitly);
6. bumps the branch to the next snapshot (`prepare-iteration: set version
   to 0.3.0-snapshot`; the next patch on a release branch). That push runs
   no CI either, which is fine: the next real commit does.

[`publish.yaml`](.github/workflows/publish.yaml), on the tag:

1. checks the tag is semver, that both `package.json` files carry it, and
   that neither image exists at that version yet (released versions are
   immutable, below);
2. builds server and client for `linux/amd64` and `linux/arm64` with
   BuildKit's SLSA provenance and SPDX SBOM attestations, pushes
   `:<version>`, `:<major>.<minor>` and, for the highest stable version,
   `:latest`, verifies both platforms and both attestations are in the
   pushed index, and signs each image with cosign;
3. generates a CycloneDX SBOM of each image with syft;
4. scans each image with Trivy into code scanning (in a job the publish
   does not wait for: a scanner outage must not strand a version whose
   images are already pushed);
5. writes the release notes: the digests, the `cosign verify` command,
   whether the release carries schema migrations (computed from the
   migration files added since the previous tag, not remembered), the
   upgrade commands, then the generated notes; attaches `checksums.txt`
   and the SBOMs; publishes the release.

Watch it:

```sh
gh run watch "$(gh run list --workflow=publish.yaml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

### Tagging by hand

The tag is what `publish.yaml` reacts to, so releasing without
`release.yaml` is releasing normally, with the stamping done by hand:

```sh
git checkout main && git pull
node scripts/release-set-version.mjs 0.2.0
git commit -s -am "prepare-release: set version to 0.2.0"
git tag -a v0.2.0 -m v0.2.0
git push origin main v0.2.0          # the tag push starts publish.yaml
node scripts/release-set-version.mjs 0.3.0-snapshot
git commit -s -am "prepare-iteration: set version to 0.3.0-snapshot" && git push
```

`publish.yaml` refuses a tag whose `package.json` versions disagree with
it, and drafts the GitHub Release itself when none exists.

## Post-release checklist

- [ ] The GitHub Release is published (not a draft) with `checksums.txt`
      and two `.cdx.json` files attached, and its notes say the right
      thing about migrations.
- [ ] `cosign verify` on both images succeeds (below), and
      `docker buildx imagetools inspect ghcr.io/lockdep/stackradar-server:<version>`
      lists `linux/amd64` and `linux/arm64`.
- [ ] The defect template's dropdown lists the new version (the release
      commit added it; check the diff rather than the form).
- [ ] **Chart**, if the release carries a migration or a breaking change
      (otherwise optional): in `lockdep/helm-charts`, bump `appVersion` to
      the new version, bump the chart `version`, update the
      `artifacthub.io/images` annotation, add a line to `UPGRADING.md` if
      values changed, merge, and run its Helm Release workflow. Until then
      `helm install` runs the previous `appVersion` and the release notes
      tell self-hosters to set `server.image.tag` and `client.image.tag`.
- [ ] **Promote to production** (maintainers): run the `Promote`
      workflow in the hosted deployment's own repository with
      `version=<version>`. It resolves the two digests from GHCR, verifies
      their cosign signatures against this repository's `publish.yaml` at
      that tag, and opens a pull request pinning the production overlay to
      them; merging it is the deploy. The hosted product runs the same
      published image a self-hoster installs, never an ad hoc build.
      Development keeps tracking `main` through `snapshot.yaml`, so the
      release has already run there in substance.
- [ ] Announce it where the people who run it are (Discussions, and the
      channels in `docs/` if the release changes a self-hosting page).

## Released versions are immutable

`publish.yaml` refuses to run if either image already exists at the
version. A published version is a promise about specific bytes:
republishing over it would invalidate every signature and digest a user
has recorded and give two people running the same tag different software.

If a release is wrong, release the next patch. Do not delete and re-push a
tag that has been published.

If `publish.yaml` failed **before it pushed anything** (a flaky runner, a
registry outage), the tag is fine and only the run needs repeating:

```sh
gh workflow run publish.yaml --ref v0.2.0
```

If `release.yaml` failed after pushing the version commit but before the
tag, re-run it: the commit already carries the version, so it has nothing
to commit and goes straight to tagging. If the tag itself is wrong (wrong
commit, wrong number) and nothing was published, delete it and release
again:

```sh
git push --delete origin v0.2.0 && git tag -d v0.2.0
gh release delete v0.2.0 --yes   # the draft
```

If it failed **after pushing one image but before the other**, the guard
blocks the retry: release the next patch.

## Verifying a release

Both images are signed with cosign keyless, so there is no public key to
distribute. The signature is bound to this repository's publish workflow at
the release tag through a short-lived Sigstore certificate and the Rekor
transparency log.

```sh
VERSION=0.2.0
cosign verify \
  --certificate-identity-regexp "^https://github.com/lockdep/stackradar/.github/workflows/publish.yaml@refs/tags/v${VERSION}\$" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "ghcr.io/lockdep/stackradar-server:${VERSION}"
cosign verify \
  --certificate-identity-regexp "^https://github.com/lockdep/stackradar/.github/workflows/publish.yaml@refs/tags/v${VERSION}\$" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "ghcr.io/lockdep/stackradar-client:${VERSION}"
```

The `:snapshot` images are signed too, by `snapshot.yaml` at
`refs/heads/main`; substitute that identity to verify one.

The provenance and SBOM attestations BuildKit produced live in the image
index rather than as cosign `.att` artifacts, so they are read with
`imagetools`:

```sh
docker buildx imagetools inspect "ghcr.io/lockdep/stackradar-server:${VERSION}" --format '{{json .Provenance}}'
docker buildx imagetools inspect "ghcr.io/lockdep/stackradar-server:${VERSION}" --format '{{json .SBOM}}'
```

The CycloneDX SBOMs attached to the GitHub Release are the human-facing
copy of the same inventory, generated from the pushed `linux/amd64`
manifest with syft; the two platforms differ only in the architecture of
the `helm` and `syft` binaries the server image carries.

## Tag policy and pin recommendations

| Tag | Resolves to | Pin it when |
|:--|:--|:--|
| `:<version>` (`:0.2.0`) | One release, forever | Production. Move it on purpose, after reading the notes of every version you skip past ([upgrading.md](docs/self-hosting/upgrading.md)). |
| `:<major>.<minor>` (`:0.2`) | The newest patch of that minor | You want fixes without reading notes; a patch never carries a breaking change or, in practice, a migration you have to prepare for. |
| `:latest` | The newest stable release | Evaluation only (the Compose quickstart's default). It crosses minors and, one day, majors. |
| `:snapshot` | The last merge to `main` | Trying what is coming ([`dev/docker-compose.yml`](dev/docker-compose.yml)). Not signed by a release, not immutable, `linux/amd64` only. |

The chart's image helper refuses a semver tag from an app major it does
not support and lets `snapshot`, `latest` and digests through as a
deliberate choice. Pin by digest (`server.image.tag: sha256:…`) when the
cluster must not re-resolve anything.

## Settings the workflows rely on

- Actions → General → *Workflow permissions* may stay **read**: every job
  declares what it needs (`contents: write` to push and release,
  `packages: write` to push images, `id-token: write` to sign,
  `security-events: write` to upload scans, `actions: write` to start
  `publish.yaml`).
- `main` and the `x.y.x` branches must accept pushes from
  `github-actions[bot]`: either unprotected, or with GitHub Actions on the
  bypass list. A ruleset that requires pull requests for every push stops
  `release.yaml` at its first commit, with nothing tagged.
- `snapshot.yaml` uses `GITOPS_DEVELOPMENT_TOKEN` only to notify the
  maintainers' development deployment of a new snapshot; without it the job
  logs that and exits 0. Nothing else needs a secret: the images are pushed
  and the release is written with `GITHUB_TOKEN`, and signing is keyless.
  Production promotion lives in the deployment repository, not here.
- The GHCR packages `stackradar-server` and `stackradar-client` are
  public; a first push would have created them private.
