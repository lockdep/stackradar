# Contributing to StackRadar

Thank you for contributing to StackRadar. Contributions in every shape are
welcome: a question that shows where the docs are unclear, a defect report
with a reproduction, a sentence fixed in a self-hosting page, a pull
request.

## Asking Questions

* Use [GitHub Discussions](https://github.com/lockdep/stackradar/discussions)
  to ask questions. A well-worded question in public is a resource for the
  next person searching for the same thing.
* Do not open issues for questions. **Questions submitted through GitHub
  issues will be closed** and pointed at Discussions.
* Avoid contacting individual contributors directly; ask in public instead.

## Filing Issues

### Looking for existing issues

Before you create a new issue, search the
[open issues](https://github.com/lockdep/stackradar/issues?q=is%3Aissue+is%3Aopen+)
to see whether the defect or enhancement has already been filed. If it
has, add what you know to the existing issue, or react with a thumbs up to
show it matters to you.

New issues must be filed using one of the provided issue templates.
**Issues that do not use a template will be closed.**

### Requesting enhancements

File a single issue per enhancement. Describe your use case and the value
you get from the change, not only the change itself.

### Reporting defects

File a single issue per defect. The more you can give us, the more likely
we reproduce it and fix it:

* The StackRadar version: the image tag, from `helm -n stackradar list`
  (the chart's `APP VERSION`) or `docker compose images`. The distribution
  (Helm, Compose, or the cloud), the Kubernetes version and the scanner
  chart version.
* Server logs: `kubectl -n stackradar logs deploy/stackradar-server`, or
  `docker compose logs server`. Client logs the same way. Errors in the UI
  are in the browser's developer console, and a failed call between the UI
  and the server is in its Network tab.
* Depending on the defect we may ask for the SBOM that triggers it. Before
  sharing SBOMs, logs or screenshots, blank or pseudonymise anything that
  reveals your organisation's internals.

## Reporting Vulnerabilities

Please refer to [SECURITY.md](SECURITY.md) for how to disclose a
vulnerability to us privately. Do not file it as an issue.

## Improving Documentation

The documentation for self-hosters is [docs/self-hosting/](docs/self-hosting/)
in this repository, plain Markdown with no build step. Every page says
which edition it applies to. Extending a page, correcting it, or adding the
question you had to ask in Discussions to the page that should have
answered it are all welcome pull requests, and need no issue first.

## Testing Snapshot Versions

Every merge to `main` builds the `:snapshot` tag of both images.
[`dev/docker-compose.yml`](dev/docker-compose.yml) runs that build on the
same Compose file as the quickstart. Trying a snapshot and saying what
broke, in Discussions, is one of the most useful things a non-contributor
can do.

## Contributing Code

Before raising a pull request, [file a defect](#reporting-defects) or an
[enhancement request](#requesting-enhancements) first, unless the change
is documentation only. It saves everyone the pull request that cannot be
merged.

* Issues we would like help with are labelled
  [`help wanted`](https://github.com/lockdep/stackradar/issues?q=is%3Aopen+label%3A%22help+wanted%22).
* Issues suitable for a first contribution are labelled
  [`good first issue`](https://github.com/lockdep/stackradar/issues?q=is%3Aopen+label%3A%22good+first+issue%22).
* [Milestones](https://github.com/lockdep/stackradar/milestones) say what
  the next release will carry. A large change, or one that breaks
  behaviour, may be scheduled for a later release.

[DEVELOPING.md](DEVELOPING.md) says how to build, run and test the two
apps; [AGENTS.md](AGENTS.md) is the domain model and its invariants, which
every change has to respect.

### What is not accepted

**Pull requests touching `server/src/cloud/` or `client/src/cloud/` are
not accepted.** Those directories hold what is only sold on the cloud
(billing, email, terms, the live demo, the feedback inbox) under the
[StackRadar Cloud Licence](server/src/cloud/LICENSE), not the AGPL, and
accepting outside changes to source-available code would need a licence
agreement we would rather not ask anyone to sign. The rest of the
repository is where contributions go; a change that needs something from a
cloud directory is a conversation to have in the issue first.
[`CODEOWNERS`](.github/CODEOWNERS) routes those paths to the maintainer.

### Pull requests

* Pull requests must use the provided template and fill in every
  applicable section. **Pull requests that do not use the template will be
  closed.**
* Pull requests that do not merge cleanly with the tip of `main` will be
  sent back for a rebase.
* Name the branch after the kind of change, then the issue number when
  there is one, then a few words: `feat/142-coverage-per-namespace`,
  `fix/158-double-counted-digests`, `docs/helm-upgrade-notes`,
  `chore/drop-dead-exports-gate`. Lowercase, hyphens, no author prefix.
  The prefixes mirror the release-note labels (`enhancement`, `defect`,
  `documentation`; `chore/` is for changes that are none of these). The
  name never reaches `main` (pull requests are squash-merged), so it is a
  convention, not a gate; the pull request title is what matters. Two
  patterns are taken: `x.y.x` is a release branch
  ([RELEASING.md](RELEASING.md)) and `dependabot/` is Dependabot's.
* Formatting is Prettier's, not yours: `pnpm format` in the app you changed
  (CI runs `pnpm format:check`). Beyond that, follow the conventions of the
  code around you. Where the existing code and a language convention
  disagree, consistency with the existing code wins.
* New behaviour comes with tests. The server tests run against a real
  PostgreSQL in a container; see DEVELOPING.md.
* A schema change comes with a forward migration that works on a populated
  database. Self-hosted installs apply the chain at boot, and the cloud is
  the oldest populated install, so a migration that only works on an empty
  database is a defect.
* Avoid new dependencies for things that are trivial to write or are in
  the standard library. A new runtime dependency has to carry a licence an
  AGPL-3.0 image may ship; the `dependency-licenses` gate checks the
  lockfile against the allow-list in
  [`scripts/check-dependency-licenses.mjs`](scripts/check-dependency-licenses.mjs).
* Do not mix unrelated whitespace or formatting changes into a change
  (Prettier makes a correctly formatted change produce none).
* The pull request title becomes a line in the release notes, under the
  category its label selects (`breaking change`, `enhancement`, `defect`,
  `dependencies`; see [`.github/release.yml`](.github/release.yml)).
  Write it for the person upgrading, and say in it when the change carries
  a migration or needs a manual step. Maintainers apply the labels;
  [RELEASING.md](RELEASING.md) is the release process.
* Commits must be [signed off](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt--s)
  (`git commit -s`) to indicate agreement with the
  [Developer Certificate of Origin](https://developercertificate.org/).
  The DCO is simpler than a contributor licence agreement, and it is
  compatible with the AGPL: your contribution is licensed under the same
  terms as the file it lands in.

### Commit messages

Pull requests are squash-merged, so what lands on `main` is one commit
whose subject is the pull request title and whose body is built from the
branch's commit messages, edited by the maintainer in the merge dialog.
The rules below therefore apply to the pull request title and description
as much as to each commit; write both so the squash needs no editing.

* **Subject**: one line, imperative mood ("Add", not "Added" or "Adds"),
  capitalised, no trailing period, no type prefix. Aim for 50 characters
  and never pass 72, where GitHub truncates. Say what changes for someone
  reading `git log`, not which file was touched: "Refuse SBOM uploads
  without a cluster-scoped key", not "Update sbom.controller.ts" or
  "Fix bug".
* **No `feat:` / `fix:` prefixes.** The branch name and the pull request
  label already carry the kind of change, the release notes are generated
  from labels rather than from commit subjects, and the subject doubles
  as a line in those notes, where a prefix reads as noise to a
  self-hoster.
* **Body**: separated from the subject by a blank line, wrapped at 72
  characters, present tense. It explains *why* the change is needed and
  *what* it does; the diff is the how. Name the consequence for someone
  running StackRadar when there is one: a migration, a changed default,
  a new or removed environment variable, a scanner version it needs.
  Name the invariant or ADR a design decision rests on. A body may be
  left out only when the subject says everything, such as a typo fix.
* **Trailers** come last, after a blank line, one per line:
  `Signed-off-by` (required, see the DCO above), `Closes #123` or
  `Refs #123`, and `Co-authored-by` for anyone who shared the work.
* **One logical change per commit** on the branch, each with a real
  message. "Address review comments" and "wip" commits are fine while a
  review is ongoing (they still need a sign-off) and are folded away by
  the squash; the maintainer removes them from the squash body.

A commit that follows all of this:

```
Gate runtime dependency licences in CI

The images ship every runtime dependency of the two AGPL-3.0 apps, so a
dependency under an incompatible or missing licence is a defect in the
release. scripts/check-dependency-licenses.mjs evaluates each runtime
package's SPDX expression against an allow-list of permissive and
weak-copyleft licences and fails on anything else. Strong copyleft is
left off the list on purpose so a human records each case in the
script's exception table with a reason.

Closes #87
Signed-off-by: Ada Lovelace <ada@example.org>
```
