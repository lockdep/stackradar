---
name: open-pr
description: Ship a change through this repository's pull request path - branch off main with the naming convention, sign off every commit (DCO), run the gates CI will run, and open a templated, labelled pull request whose title reads as a release-note line. Use when the user asks to open a PR, ship, commit and push, or land a change.
---

# Open a pull request

`main` accepts nothing but squash- or rebase-merged pull requests with six
green checks and resolved review threads; a ruleset enforces it and no one
bypasses it. This skill is the sequence from "the change is done" to "the
pull request is open and will pass". The rules themselves live in
[CONTRIBUTING.md](../../../CONTRIBUTING.md) (branch names, commit
messages, the template, labels) and [DEVELOPING.md](../../../DEVELOPING.md)
(the gates). Read the relevant section there when in doubt; do not rely on
a paraphrase here.

Report every step's outcome faithfully. A failing gate is reported with
its output and fixed before pushing, not described as "should pass".

## 1. Where are we?

```sh
git status --short --branch
git log --oneline main..HEAD
```

- **On `main` with uncommitted or unpushed work:** create the branch now
  (step 2) and carry the work over. Never commit on `main`; a push there
  is rejected anyway.
- **On a branch already:** check its name against the convention. Rename
  with `git branch -m` if it is off; the name has not been published yet.
- **Nothing to ship:** stop and say so.

## 2. Branch

`<kind>/<issue-number>-<a-few-words>`, lowercase, hyphens, no author
prefix. The kind is one of:

| Prefix | Use for | Label it will carry |
|:--|:--|:--|
| `feat/` | new capability or changed behaviour | `enhancement` |
| `fix/` | something that does not work as documented | `defect` |
| `docs/` | documentation only | `documentation` |
| `chore/` | CI, tooling, refactors with no behaviour change | none |

Omit the issue number when there is no issue. `x.y.x` (release branches)
and `dependabot/` are reserved.

## 3. Commits

Check every commit the branch adds:

```sh
git log --format='%h %s%n%(trailers:key=Signed-off-by)' main..HEAD
```

- **Missing `Signed-off-by` on any commit:** `git rebase --signoff main`.
  If the hook is not enabled in this clone, enable it so it does not
  happen again: `git config core.hooksPath .githooks`. New commits are
  `git commit -s`.
- **Subject** of each commit: imperative, capitalised, no period, no
  `feat:`-style prefix, under 72 characters, saying what changes for a
  reader of `git log`. "Update sbom.controller.ts" and "Fix bug" fail
  this; "Refuse SBOM uploads without a cluster-scoped key" passes.
- **Body** explains why and what. It names any consequence for an
  operator (migration, changed default, environment variable, scanner
  version) and the ADR a design decision rests on.
- "wip" and "address review" commits are tolerated on the branch (still
  signed off); the squash folds them away.

Commits the agent authors end with the attribution trailer the session
asks for, before `Signed-off-by`.

## 4. Run the gates locally

Every `pnpm` command runs inside `server/` or `client/`; there is no root
package. Run what applies to the files the branch touches, from the
cheapest up:

```sh
# Changed files decide which apps are involved
git diff --name-only main...HEAD

# Formatting is a hard gate in both apps
(cd server && pnpm format:check)      # if server/ changed
(cd client && pnpm format:check)      # if client/ changed

# Bare-node drift scripts, cheap, run them all when their inputs changed
node scripts/check-cloud-boundary.mjs           # anything under src/
node scripts/check-cross-app-constants.mjs      # shared constants
node server/scripts/sync-osv-schema.mjs --verify  # server/src/osv-sync/schema

# Lint, types, dead exports
(cd server && pnpm typecheck && pnpm lint && pnpm knip)
(cd client && pnpm lint && pnpm knip)

# Tests. The server suite needs Docker up (Testcontainers)
(cd server && pnpm test)
(cd client && pnpm test)
```

`pnpm format` fixes formatting; commit the result as part of the change,
never as a separate whitespace commit. A dependency change also runs
`node scripts/check-dependency-licenses.mjs` after `pnpm install`.

## 5. Things that need a sentence in the pull request

Look at the diff for these before writing the body:

- **A migration** under `server/drizzle/` or `client/drizzle/`: the title
  says so ("… (migration)"), the body says it was generated with
  `pnpm db:generate` and works on a populated database. Never apply it to
  a database you do not own.
- **`server/src/cloud/` or `client/src/cloud/`**: the Cloud-licensed
  directories. Outside contributors' PRs there are not accepted; a
  maintainer's PR touching them says why in the body.
- **An environment variable, a default, or a wire contract**
  (`docs/contracts/`): called out in the title for the person upgrading,
  and the matching page under `docs/self-hosting/` is updated in the
  same PR.
- **An invariant from AGENTS.md** ("The model" section): the PR links the
  ADR it adds or amends.

## 6. Push and open

```sh
git push -u origin HEAD
gh pr create --title "<subject>" --label <label> --body-file <file>
```

- **Title** obeys the commit-subject rules; it becomes the squash commit
  subject and a line in the release notes under the label's heading.
- **Body** is the template at
  [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md)
  with every section kept and filled, not replaced by free text. Write
  it to a file first (`gh pr create --body-file`) so the HTML comments
  and checklist survive. "Addressed Issue" is `Closes #N`, or `docs` for
  a documentation-only change, or `none: <one-line reason>` for a
  maintainer's small change. Tick the checklist items that apply and
  strike through the ones that do not (`~text~`).
- **Label**: exactly one of `enhancement`, `defect`, `documentation`,
  `breaking change`, chosen by the table in step 2; `breaking change`
  overrides the others when behaviour, schema or configuration changes
  incompatibly. Dependabot's `dependencies` is not applied by hand.
- **Draft** (`--draft`) when the change is large and early feedback is
  the point; see "Shared Feature Branches" in DEVELOPING.md.

Then watch the checks once:

```sh
gh pr checks --watch
```

Report the PR URL and the check results as they are. A red check is fixed
on the branch and pushed; do not re-run it hoping for green.

## Not this skill's job

- Creating or triaging issues: the `triage` skill.
- Releasing: `RELEASING.md` has the checklist; a release is a workflow
  run, not a pull request.
- Merging: the maintainer merges from the GitHub dialog, trimming fixup
  lines from the squash body. The agent does not merge.
