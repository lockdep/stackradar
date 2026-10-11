/**
 * `lib/image-control.ts` — who controls an image. Pure, so this is the
 * contract: one fixture per signal, the order between them, and the
 * mirrored-vendor-image trap.
 */

import { describe, it, expect } from "vitest";
import { matchingRule, resolveControl, type ControlInput } from "../../../src/lib/image-control.js";

const input = (overrides: Partial<ControlInput>): ControlInput => ({
    registry: "docker.io",
    repository: "acme/api",
    rules: [],
    deliveringCharts: [],
    official: false,
    ...overrides,
});

const prometheusChart = {
    chartName: "kube-prometheus-stack",
    repositories: new Set(["prometheus/prometheus", "grafana/grafana", "library/busybox"]),
};

describe("resolveControl — one fixture per signal", () => {
    it("1. an org rule always wins", () => {
        expect(
            resolveControl(
                input({
                    registry: "quay.io",
                    repository: "prometheus/prometheus",
                    rules: [{ registry: null, repository: "prometheus/*", control: "built" }],
                    deliveringCharts: [prometheusChart],
                    official: true,
                }),
            ),
        ).toEqual({ control: "built", detectedBy: "rule", detail: null });
    });

    it("2. delivered by a public chart whose renders name the repository", () => {
        expect(
            resolveControl(
                input({
                    registry: "quay.io",
                    repository: "prometheus/prometheus",
                    deliveringCharts: [prometheusChart],
                }),
            ),
        ).toEqual({ control: "third-party", detectedBy: "chart", detail: "kube-prometheus-stack" });
    });

    it("3. a Docker Official Image, wherever it lives", () => {
        expect(
            resolveControl(input({ registry: "harbor.corp.example", repository: "proxy/nginx", official: true })),
        ).toEqual({
            control: "third-party",
            detectedBy: "official-image",
            detail: null,
        });
    });

    it("4. a private registry", () => {
        expect(
            resolveControl(input({ registry: "123456789.dkr.ecr.eu-west-1.amazonaws.com", repository: "api" })),
        ).toEqual({
            control: "built",
            detectedBy: "private-registry",
            detail: "123456789.dkr.ecr.eu-west-1.amazonaws.com",
        });
    });

    it("5. the layer comparison, when item 6 supplies one", () => {
        expect(resolveControl(input({ layerMatch: "known-image" }))).toMatchObject({
            control: "third-party",
            detectedBy: "known-image",
        });
        expect(resolveControl(input({ layerMatch: "built-on-known" }))).toMatchObject({
            control: "built",
            detectedBy: "built-on-known",
        });
    });

    it("6. a vendor namespace on a public registry", () => {
        for (const [registry, repository] of [
            [null, "nginx"],
            ["docker.io", "library/redis"],
            ["quay.io", "argoproj/argocd"],
            ["registry.k8s.io", "ingress-nginx/controller"],
            ["gcr.io", "google-containers/pause"],
            ["mcr.microsoft.com", "dotnet/aspnet"],
        ] as const) {
            expect(resolveControl(input({ registry, repository })), `${registry}/${repository}`).toMatchObject({
                control: "third-party",
                detectedBy: "public-registry",
            });
        }
    });

    it("7. anything left is unknown — a public registry says nothing about an org's own namespace", () => {
        for (const [registry, repository] of [
            ["docker.io", "acme/api"],
            ["ghcr.io", "acme/worker"],
            ["gcr.io", "acme-prod/api"],
        ] as const) {
            expect(resolveControl(input({ registry, repository }))).toEqual({
                control: "unknown",
                detectedBy: null,
                detail: null,
            });
        }
        expect(resolveControl(input({ repository: null }))).toMatchObject({ control: "unknown" });
    });
});

describe("the mirrored-vendor-image trap", () => {
    it("a chart-delivered image in a private mirror is third-party: the chart beats the registry", () => {
        expect(
            resolveControl(
                input({
                    registry: "harbor.corp.example",
                    repository: "quay-proxy/prometheus/prometheus",
                    deliveringCharts: [prometheusChart],
                }),
            ),
        ).toEqual({ control: "third-party", detectedBy: "chart", detail: "kube-prometheus-stack" });
    });

    it("matches a mirrored official image rendered as library/<name>", () => {
        expect(
            resolveControl(
                input({
                    registry: "harbor.corp.example",
                    repository: "dockerhub/busybox",
                    deliveringCharts: [prometheusChart],
                }),
            ),
        ).toMatchObject({ control: "third-party", detectedBy: "chart" });
    });

    it("does not call the org's own image third-party because a generic public chart runs it", () => {
        const appTemplate = { chartName: "app-template", repositories: new Set(["library/busybox"]) };
        expect(
            resolveControl(
                input({ registry: "registry.corp.example", repository: "team/api", deliveringCharts: [appTemplate] }),
            ),
        ).toMatchObject({ control: "built", detectedBy: "private-registry" });
    });
});

describe("matchingRule", () => {
    const rules = [
        { registry: null, repository: "acme/*", control: "built" as const },
        { registry: null, repository: "acme/vendored-tool", control: "third-party" as const },
        { registry: "ghcr.io", repository: "acme/*", control: "third-party" as const },
    ];

    it("prefers the exact repository over a prefix", () => {
        expect(matchingRule(rules, "docker.io", "acme/vendored-tool")?.control).toBe("third-party");
        expect(matchingRule(rules, "docker.io", "acme/api")?.control).toBe("built");
    });

    it("prefers a registry-scoped rule, comparing registries normalised", () => {
        expect(matchingRule(rules, "ghcr.io", "acme/api")?.control).toBe("third-party");
        expect(
            matchingRule([{ registry: "index.docker.io", repository: "acme/api", control: "built" }], null, "acme/api")
                ?.control,
        ).toBe("built");
    });

    it("is null when nothing matches", () => {
        expect(matchingRule(rules, "docker.io", "other/api")).toBeNull();
    });
});
