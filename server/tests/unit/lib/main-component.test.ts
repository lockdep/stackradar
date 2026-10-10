/**
 * `lib/main-component.ts` — which component is the application. Pure; the
 * refusals matter as much as the hits.
 */

import { describe, it, expect } from "vitest";
import { detectMainComponent, mainCandidateOf, narrowMain, upstreamRepository, type MainCandidate } from "../../../src/lib/main-component.js";

const go = (id: string, name: string, path: string, mainModule: string): MainCandidate => ({ id, name, packageType: "go-module", path, mainModule });
const binary = (id: string, name: string, path: string): MainCandidate => ({ id, name, packageType: "binary", path, mainModule: null });

const ARGOCD: MainCandidate[] = [
    go("server-main", "github.com/argoproj/argo-cd/v3", "/usr/local/bin/argocd", "github.com/argoproj/argo-cd/v3"),
    go("server-dep", "golang.org/x/net", "/usr/local/bin/argocd", "github.com/argoproj/argo-cd/v3"),
    go("helm-main", "helm.sh/helm/v3", "/usr/local/bin/helm", "helm.sh/helm/v3"),
    go("kustomize-main", "sigs.k8s.io/kustomize/kustomize/v5", "/usr/local/bin/kustomize", "sigs.k8s.io/kustomize/kustomize/v5"),
];

describe("detectMainComponent", () => {
    it("picks the main module of the entrypoint's binary, not of every binary in the image", () => {
        expect(detectMainComponent({ entrypoint: "/usr/local/bin/argocd" }, ARGOCD)).toEqual({ componentId: "server-main", via: "go-main-module" });
    });

    it("falls through a wrapper entrypoint to the command", () => {
        expect(detectMainComponent({ entrypoint: "/usr/bin/tini", cmd: "/usr/local/bin/argocd" }, ARGOCD)).toEqual({ componentId: "server-main", via: "go-main-module" });
        expect(detectMainComponent({ entrypoint: "/docker-entrypoint.sh", cmd: "nginx" }, [binary("nginx", "nginx", "/usr/sbin/nginx")])).toEqual({ componentId: "nginx", via: "binary" });
    });

    it("resolves a bare command name along the usual PATH", () => {
        expect(detectMainComponent({ cmd: "redis-server" }, [binary("redis", "redis", "/usr/local/bin/redis-server")])).toEqual({ componentId: "redis", via: "binary" });
    });

    it("refuses a wrapper, an interpreter, and a path the SBOM does not know", () => {
        expect(detectMainComponent({ entrypoint: "/bin/sh" }, ARGOCD)).toEqual({ componentId: null, reason: "wrapper" });
        expect(detectMainComponent({ entrypoint: "/run.sh" }, ARGOCD)).toEqual({ componentId: null, reason: "wrapper" });
        expect(detectMainComponent({ entrypoint: "/opt/java/openjdk/bin/java" }, [binary("java", "java", "/opt/java/openjdk/bin/java")])).toEqual({ componentId: null, reason: "interpreter" });
        expect(detectMainComponent({ entrypoint: "/app/server" }, ARGOCD)).toEqual({ componentId: null, reason: "not-in-sbom" });
        expect(detectMainComponent({}, ARGOCD)).toEqual({ componentId: null, reason: "no-entrypoint" });
    });
});

describe("upstreamRepository", () => {
    it("normalises the forms OCI source labels take", () => {
        expect(upstreamRepository("https://github.com/grafana/grafana")).toBe("github.com/grafana/grafana");
        expect(upstreamRepository("https://github.com/nginx/docker-nginx.git#eaf8875:mainline/alpine")).toBe("github.com/nginx/docker-nginx");
        expect(upstreamRepository("git@github.com:dexidp/dex.git")).toBe("github.com/dexidp/dex");
        expect(upstreamRepository("https://gitlab.com/group/project/-/tree/main")).toBe("gitlab.com/group/project");
    });

    it("is null for anything that is not a repository on a known forge", () => {
        expect(upstreamRepository("https://example.com/downloads")).toBeNull();
        expect(upstreamRepository("")).toBeNull();
        expect(upstreamRepository(null)).toBeNull();
    });
});

describe("narrowMain", () => {
    it("leaves one main where the image named its application, and demotes the rest to application", () => {
        expect(narrowMain(["main", "application", "main", "main", "os"], { componentId: "0", via: "go-main-module" })).toEqual(["main", "application", "application", "application", "os"]);
    });

    it("promotes the fingerprinted executable the image exists to run", () => {
        expect(narrowMain(["os", "runtime", "runtime"], { componentId: "1", via: "binary" })).toEqual(["os", "main", "runtime"]);
    });

    it("changes nothing on a refusal", () => {
        expect(narrowMain(["main", "main"], { componentId: null, reason: "wrapper" })).toEqual(["main", "main"]);
    });
});

describe("mainCandidateOf", () => {
    it("reads the three syft properties", () => {
        expect(
            mainCandidateOf("7", "github.com/dexidp/dex", [
                { name: "syft:package:type", value: "go-module" },
                { name: "syft:location:0:path", value: "/usr/local/bin/dex" },
                { name: "syft:metadata:mainModule", value: "github.com/dexidp/dex" },
            ])
        ).toEqual({ id: "7", name: "github.com/dexidp/dex", packageType: "go-module", path: "/usr/local/bin/dex", mainModule: "github.com/dexidp/dex" });
    });
});
