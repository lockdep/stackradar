/**
 * Extract the images a rendered chart deploys — a **YAML walk, not a regex**.
 *
 * The walk visits every PodSpec Kubernetes defines a location for — workload
 * kinds, CronJob templates, bare Pods (which is what hook Jobs and hook Pods
 * are once rendered) — and collects `image` from `containers`,
 * `initContainers` and `ephemeralContainers`.
 *
 * What it deliberately does and does not see:
 * - **Hooks are included**: they run at install and their images are real.
 * - **Test manifests are excluded**: `helm template` renders `templates/tests/`
 *   like everything else, but a `helm.sh/hook: test` resource never runs in
 *   normal operation, so its image is not something the chart deploys.
 * - **Operator-flag images are a known gap**: an image referenced only inside
 *   a container argument or a CRD payload (the prometheus-operator
 *   config-reloader pattern) is not in any PodSpec and is not guessed at — it
 *   surfaces later as `unmeasuredImages` on the suggestion.
 *
 * Malformed documents cost themselves, not the stream: a chart that renders
 * one broken document alongside forty good ones still yields the forty.
 */

import { parseAllDocuments } from "yaml";

/** `kind` → path from the resource root to its PodSpec. */
const POD_SPEC_PATHS: Record<string, string[]> = {
    Pod: ["spec"],
    Deployment: ["spec", "template", "spec"],
    StatefulSet: ["spec", "template", "spec"],
    DaemonSet: ["spec", "template", "spec"],
    ReplicaSet: ["spec", "template", "spec"],
    ReplicationController: ["spec", "template", "spec"],
    Job: ["spec", "template", "spec"],
    CronJob: ["spec", "jobTemplate", "spec", "template", "spec"],
};

const CONTAINER_LISTS = ["containers", "initContainers", "ephemeralContainers"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function dig(root: unknown, path: string[]): unknown {
    let current = root;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
}

/** A `helm.sh/hook: test` (or legacy `test-success`/`test-failure`) resource. */
function isTestHook(resource: Record<string, unknown>): boolean {
    const metadata = resource["metadata"];
    if (!isRecord(metadata)) return false;
    const annotations = metadata["annotations"];
    if (!isRecord(annotations)) return false;
    const hook = annotations["helm.sh/hook"];
    if (typeof hook !== "string") return false;
    return hook
        .split(",")
        .map((h) => h.trim())
        .some((h) => h === "test" || h === "test-success" || h === "test-failure");
}

/**
 * Every image reference the rendered stream's PodSpecs name, deduplicated and
 * sorted. Input is the full multi-document output of `helm template`.
 */
export function extractPodImages(rendered: string): string[] {
    const images = new Set<string>();

    let documents;
    try {
        documents = parseAllDocuments(rendered);
    } catch {
        return [];
    }

    for (const doc of documents) {
        if (doc.errors.length > 0) continue;

        let resource: unknown;
        try {
            resource = doc.toJS();
        } catch {
            continue;
        }
        if (!isRecord(resource)) continue;

        const kind = resource["kind"];
        if (typeof kind !== "string") continue;
        const path = POD_SPEC_PATHS[kind];
        if (!path) continue;
        if (isTestHook(resource)) continue;

        const podSpec = dig(resource, path);
        if (!isRecord(podSpec)) continue;

        for (const listName of CONTAINER_LISTS) {
            const list = podSpec[listName];
            if (!Array.isArray(list)) continue;
            for (const container of list) {
                if (!isRecord(container)) continue;
                const image = container["image"];
                if (typeof image === "string" && image.length > 0) {
                    images.add(image);
                }
            }
        }
    }

    return [...images].sort();
}
