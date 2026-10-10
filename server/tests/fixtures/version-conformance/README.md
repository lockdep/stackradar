# Version comparison conformance corpora

Vendored from [google/osv-scalibr](https://github.com/google/osv-scalibr),
`semantic/testdata/`.

| | |
|---|---|
| Upstream commit | `d64e793fde891877788dcbb731254c22ab2580a8` |
| Commit date | 2026-08-03 |
| Licence | Apache-2.0 (see `LICENSE-APACHE-2.0`) |
| Retrieved | 2026-08-05 |

The `*-generated.txt` files were produced upstream by running the real package
managers over version pairs harvested from the OSV database; the hand-written
files encode edge cases upstream ran into. Together they are ~72,000 ordering
assertions — the reason `server/src/matching/version/` can be built with
confidence rather than by inspection.

## Format

One assertion per line, `<a> <operator> <b>`, operator one of `<`, `=`, `>`.
Blank lines are skipped; so are lines starting with `# ` or `// `.

```
1.36.0rc1 > 1.35.0
1.0.0.dev1 < 1.0.0
```

Note the comment prefixes include the trailing space — upstream's scanner
requires it, and a line like `#4 < #5` would be an assertion, not a comment.
The harness in `tests/unit/matching/version/conformance.test.ts` matches that
behaviour exactly.

## File → scheme

| File(s) | Scheme |
|---|---|
| `alpine-versions*.txt` | `apk` |
| `debian-versions*.txt` | `dpkg` |
| `redhat-versions.txt` | `rpm` |
| `pypi-versions*.txt` | `pep440` |
| `maven-versions*.txt` | `maven` |
| `rubygems-versions*.txt` | `gem` |
| `nuget-versions.txt` | `nuget` |
| `packagist-versions*.txt` | `composer` |
| `semver-versions.txt` | `semver` |

Upstream also ships `cran-`, `pub-` and `hackage-versions.txt`. We do not
ingest those ecosystems, so they are not vendored.

## Exclusions

`exclusions.ts` lists the assertions we deliberately fail, each with a reason.
Every exclusion is a *known* divergence from upstream, not a bug we have not
got round to. There are no silent skips: the harness asserts that every
excluded line is present in its corpus and that it does in fact still fail, so
an exclusion that becomes stale breaks the build.

## Updating

Re-copy the files, update the commit SHA above, and re-run the suite. New
upstream assertions that fail are either a real bug in our comparators or a new
deliberate divergence — decide which, and never paper over one with the other.
