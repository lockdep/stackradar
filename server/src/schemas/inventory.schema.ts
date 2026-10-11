import { z } from "zod";
import { GITOPS_TOOLS } from "../db/schema/gitops-applications.js";

/*
 * Shape validation for names that later reach a copy-pasteable command
 * (security review S10). Kubernetes itself enforces DNS-1123 on object
 * names, so a report failing these patterns is forged or corrupt, never a
 * legitimate cluster — rejecting the whole report is correct (the same
 * argument as the container cap below). `remediation-commands.ts` quotes on
 * top of this; the schema is the first fence, not the only one.
 */

/** RFC 1123 subdomain — every Kubernetes object name fits this. */
const DNS_1123 = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const dnsName = (max: number = 253) => z.string().min(1).max(max).regex(DNS_1123, "must be a DNS-1123 name");
/** The reference charset of every image-ref part: no whitespace, no shell metacharacters. */
const IMAGE_REF = /^[A-Za-z0-9._:/@-]+$/;
/** OCI tag grammar. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** `algorithm:hex` — sha256 today, charset-bounded rather than pinned to it. */
const IMAGE_DIGEST = /^[a-z0-9-]+:[A-Fa-f0-9]{32,}$/;
/** Semver plus the pre-release/build punctuation charts actually use. */
const VERSION_ISH = /^[A-Za-z0-9._+-]+$/;
/** PascalCase Kubernetes kind. */
const KUBE_KIND = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * `POST /v1/inventory` payload, v3.
 *
 * Derived from [contracts/inventory-v3.md](../../../docs/contracts/inventory-v3.md),
 * which is the shared definition both repos encode. Change the contract first.
 *
 * **No `.strict()` anywhere, deliberately.** Unknown fields are ignored so a
 * newer scanner can add one without coordinating a server release; the two
 * release independently and always will.
 */

/**
 * A Helm release — the **packaging** layer.
 *
 * v2 carried a `source: helm | argocd | flux` here. It is gone: ArgoCD commonly
 * deploys *via* Helm, so a workload has both layers at once and a discriminator
 * forces a choice between two true answers. Every row here is a Helm release,
 * and the delivery layer is `applicationSchema` below.
 */
const releaseSchema = z.object({
    name: dnsName(),
    /** The **release's** namespace, from `meta.helm.sh/release-namespace`. */
    namespace: dnsName(),
    chartName: z
        .string()
        .max(253)
        .regex(VERSION_ISH)
        .nullish()
        .transform((v) => v ?? null),
    chartVersion: z
        .string()
        .max(128)
        .regex(VERSION_ISH)
        .nullish()
        .transform((v) => v ?? null),
    /**
     * The **application's** version, kept distinct from `chartVersion` even
     * when equal. Charts stamp their own version into
     * `app.kubernetes.io/version` often enough that equality proves nothing,
     * and no code path may derive one from the other.
     */
    appVersion: z
        .string()
        .max(128)
        .regex(VERSION_ISH)
        .nullish()
        .transform((v) => v ?? null),
    /** `null` = unknown, not "no repo". Only a GitOps source object supplies it. */
    repoUrl: z
        .string()
        .max(2048)
        .nullish()
        .transform((v) => v ?? null),
});

/**
 * A GitOps application — the **delivery** layer.
 *
 * Unknown `tool` values are rejected rather than stored: an unrecognised one
 * would become a silent third state that nothing renders and nothing filters
 * on. `flux` is accepted but not yet produced by any agent.
 */
const applicationSchema = z.object({
    name: dnsName(),
    /** The **application object's** own namespace, e.g. `argocd`. */
    namespace: dnsName(),
    tool: z.enum(GITOPS_TOOLS),
    /* All five are null when the row came from a workload's tracking
       annotation alone, which is everything the agent has without RBAC for the
       `Application` object itself. */
    repoUrl: z
        .string()
        .max(2048)
        .nullish()
        .transform((v) => v ?? null),
    targetRevision: z
        .string()
        .max(253)
        .nullish()
        .transform((v) => v ?? null),
    chart: z
        .string()
        .max(253)
        .nullish()
        .transform((v) => v ?? null),
    path: z
        .string()
        .max(2048)
        .nullish()
        .transform((v) => v ?? null),
    destinationNamespace: dnsName()
        .nullish()
        .transform((v) => v ?? null),
});

const containerSchema = z.object({
    name: dnsName(),
    init: z.boolean().default(false),
    imageRef: z.string().min(1).max(2048).regex(IMAGE_REF),
    /** Identity. A container with no resolved digest cannot be recorded. */
    imageDigest: z.string().min(1).max(128).regex(IMAGE_DIGEST),
    /** `null` for a digest-pinned deployment. Never invent `"latest"`. */
    imageTag: z
        .string()
        .regex(IMAGE_TAG)
        .nullish()
        .transform((v) => v ?? null),
    registry: z
        .string()
        .max(255)
        .regex(IMAGE_REF)
        .nullish()
        .transform((v) => v ?? null),
    repository: z
        .string()
        .max(512)
        .regex(IMAGE_REF)
        .nullish()
        .transform((v) => v ?? null),
    /** Pods **observed** running this container on this digest. */
    runningPods: z
        .number()
        .int()
        .min(1)
        .nullish()
        .transform((v) => v ?? null),
});

const workloadSchema = z.object({
    /**
     * `null` when the `ownerReferences` chain dead-ends. Explicitly nullable
     * rather than defaulted: a schema that filled in `"Pod"` would make an
     * unresolvable owner indistinguishable from a genuinely bare pod, and the
     * remediation command generated from it would be wrong.
     */
    kind: z
        .string()
        .max(63)
        .regex(KUBE_KIND)
        .nullish()
        .transform((v) => v ?? null),
    name: dnsName(),
    /** Natural-key reference into `releases[]`. A dangling one is a 400. */
    release: z
        .object({
            name: dnsName(),
            namespace: dnsName(),
        })
        .nullish()
        .transform((v) => v ?? null),
    /**
     * Natural-key reference into `applications[]`, independent of `release`.
     *
     * A workload may carry both, and on a cluster where ArgoCD renders Helm
     * charts most do. A dangling one is a 400, for the same reason a dangling
     * release reference is.
     */
    application: z
        .object({
            name: dnsName(),
            namespace: dnsName(),
        })
        .nullish()
        .transform((v) => v ?? null),
    runningPods: z
        .number()
        .int()
        .min(1)
        .nullish()
        .transform((v) => v ?? null),
    firstStartedAt: z.iso
        .datetime()
        .nullish()
        .transform((v) => (v ? new Date(v) : null)),
    labels: z
        .record(z.string(), z.string())
        .nullish()
        .transform((v) => v ?? null),
    containers: z.array(containerSchema),
});

/**
 * Why a digest in this report has no SBOM — display-only classification, and
 * the whole failure surface: **never raw syft stderr**, which carries full
 * registry URLs and API response bodies. `code` is deliberately a charset
 * check rather than an enum: the set is open (`registry_auth` |
 * `registry_rate_limited` | `scan_error` today), a newer scanner may add one,
 * and the UI renders anything it does not recognise as a generic scan
 * failure — rejecting the whole report over a new code would orphan the
 * inventory of every upgraded cluster.
 */
const scanFailureSchema = z.object({
    imageDigest: z.string().min(1).max(128).regex(IMAGE_DIGEST),
    code: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case code"),
    registryHost: z
        .string()
        .max(255)
        .regex(IMAGE_REF)
        .nullish()
        .transform((v) => v ?? null),
});

const namespaceSchema = z.object({
    name: dnsName(63),
    /**
     * **`null` (not collected — RBAC absent) is different from `{}` (collected,
     * none present).** `.nullish()` keeps both reachable; a `.default({})`
     * would make a permissions failure indistinguishable from an unlabelled
     * namespace, which is exactly the confusion the contract forbids.
     */
    labels: z
        .record(z.string(), z.string())
        .nullish()
        .transform((v) => v ?? null),
    workloads: z.array(workloadSchema),
});

/**
 * The cap is a request-size guard, not a product limit. It is well above the
 * container count of any cluster we expect and below anything that would make
 * one POST expensive to parse. Over it the scanner gets a 400 and **the whole
 * report is rejected** — the failure mode being avoided is recording a
 * truncated cluster as fully discovered.
 */
export const MAX_INVENTORY_CONTAINERS = 10_000;

/** The version a new scanner sends — the current contract. */
export const INVENTORY_VERSION = 3;

/**
 * Every version the server still accepts. A *set*, even while it has one
 * member: the day v4 ships, v3 agents in customer clusters keep reporting for
 * as long as they are allowed to — they are orphaned only by removal from
 * this list, never by the addition of a newer version. A version that differs
 * in shape needs its own schema branch below; a version that is a strict
 * superset can share one.
 */
export const SUPPORTED_INVENTORY_VERSIONS: readonly number[] = [INVENTORY_VERSION];

export function isSupportedInventoryVersion(version: unknown): version is number {
    return typeof version === "number" && SUPPORTED_INVENTORY_VERSIONS.includes(version);
}

export const inventoryReportSchema = z
    .object({
        version: z.number().refine(isSupportedInventoryVersion, {
            message: `Unsupported inventory payload version — this server accepts version ${SUPPORTED_INVENTORY_VERSIONS.join(", ")}`,
        }),
        /** Producer clock. **Advisory only** — the server stamps rows itself. */
        reportedAt: z.iso.datetime(),
        /** See the empty-report hazard in the contract. */
        informerSynced: z.boolean(),
        /**
         * `false` when the agent could not read its workloads' controllers.
         *
         * Defaulted to `true` rather than required so a producer that never
         * looks — a test fixture, a hand-written report — does not claim a
         * permissions failure it did not have. The real agent always sends it.
         */
        ownerMetadataCollected: z.boolean().default(true),
        releases: z.array(releaseSchema).default([]),
        applications: z.array(applicationSchema).default([]),
        /** Optional and additive — a scanner that predates it sends nothing. */
        scanFailures: z.array(scanFailureSchema).default([]),
        namespaces: z.array(namespaceSchema),
    })
    .superRefine((report, ctx) => {
        const total = report.namespaces.reduce(
            (sum, ns) => sum + ns.workloads.reduce((n, w) => n + w.containers.length, 0),
            0,
        );
        if (total > MAX_INVENTORY_CONTAINERS) {
            ctx.addIssue({
                code: "custom",
                message: `An inventory report may contain at most ${MAX_INVENTORY_CONTAINERS} containers (received ${total})`,
            });
        }

        /*
         * A workload pointing at a release that is not in `releases[]` is a
         * producer bug, and the honest response is a 400. Silently dropping the
         * link would leave the workload looking unmanaged, which reads as a
         * true fact about the cluster rather than as a lost one.
         */
        const declaredReleases = new Set(report.releases.map((r) => `${r.namespace}\u0000${r.name}`));
        const declaredApplications = new Set(report.applications.map((a) => `${a.namespace}\u0000${a.name}`));
        for (const ns of report.namespaces) {
            for (const w of ns.workloads) {
                if (w.release && !declaredReleases.has(`${w.release.namespace}\u0000${w.release.name}`)) {
                    ctx.addIssue({
                        code: "custom",
                        message: `Workload ${ns.name}/${w.name} references release ${w.release.namespace}/${w.release.name}, which is not present in releases[]`,
                    });
                }
                if (
                    w.application &&
                    !declaredApplications.has(`${w.application.namespace}\u0000${w.application.name}`)
                ) {
                    ctx.addIssue({
                        code: "custom",
                        message: `Workload ${ns.name}/${w.name} references application ${w.application.namespace}/${w.application.name}, which is not present in applications[]`,
                    });
                }
            }
        }
    });
