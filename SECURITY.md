# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities in StackRadar privately; either way works:

* **GitHub:** [open a private vulnerability report](https://github.com/lockdep/stackradar/security/advisories/new)
  on this repository.
* **Email:** [security@stackradar.io](mailto:security@stackradar.io), with
  the word "SECURITY" in the subject line.

Include enough detail to reproduce the issue: the version, the
distribution (Helm, Compose, or the cloud), and the steps. We acknowledge
reports within **two working days** and keep you informed while we
investigate and fix. Please do not disclose publicly until we have had a
chance to respond; we credit reporters in the release notes unless asked
not to.

Report security issues in third-party packages to the people who maintain
them. If StackRadar's use of such a package is the problem, tell us as well.

## Scope

* This repository: the server, the client and the Compose quickstart.
* The Helm chart in [lockdep/helm-charts](https://github.com/lockdep/helm-charts).
* The scanner agent and its chart in [lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner).
* The hosted service at `app.stackradar.io`, `api.stackradar.io` and
  `stackradar.io`.

Please do not test the hosted service in a way that degrades it for other
users; a self-hosted install from the quickstart is the right place to
look for most classes of issue.

## Supported versions

Security fixes land in the **latest minor release** of StackRadar and in
the latest release of the chart and the scanner. Older versions are not
patched retroactively; released images and chart versions are immutable,
so upgrading to the latest release is always the fix path.

## Verifying what you install

Images are signed with Sigstore Cosign (keyless) from the build workflow
and the Helm charts are GPG-signed with `.prov` files; verification steps
are in the [helm-charts README](https://github.com/lockdep/helm-charts#verifying-charts)
and the [scanner README](https://github.com/lockdep/stackradar-scanner#verifying-what-you-install).

More on StackRadar's security posture: <https://stackradar.io/security>.
