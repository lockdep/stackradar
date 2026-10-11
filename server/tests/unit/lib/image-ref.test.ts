import { describe, it, expect } from "vitest";
import { parseImageRef } from "../../../src/lib/image-ref.js";

describe("parseImageRef", () => {
    it("splits a tagged registry ref", () => {
        expect(parseImageRef("docker.io/library/nginx:1.25")).toEqual({
            registry: "docker.io",
            repository: "library/nginx",
            tag: "1.25",
            digest: undefined,
        });
    });

    it("keeps a registry port out of the tag", () => {
        expect(parseImageRef("localhost:5000/myapp:dev")).toEqual({
            registry: "localhost:5000",
            repository: "myapp",
            tag: "dev",
            digest: undefined,
        });
    });

    it("leaves tag undefined for a digest-pinned ref", () => {
        expect(parseImageRef("nginx@sha256:abc")).toEqual({
            registry: undefined,
            repository: "nginx",
            tag: undefined,
            digest: "sha256:abc",
        });
    });

    // containerd reports `containerStatus.image` as a bare image ID
    // (`sha256:` + 64 hex) when a digest-pinned pod gives it no tag; the hex
    // must never come back out as a "tag" or a repository name.
    describe("bare image IDs", () => {
        const hex = "a4a8af0db08902e65347157c5efef6d1f9e261f03c8aa14b1b40bc182b947fe7";
        const id = `sha256:${hex}`;

        it("parses to no name and no tag, ID as digest", () => {
            expect(parseImageRef(id)).toEqual({
                registry: undefined,
                repository: "",
                tag: undefined,
                digest: id,
            });
        });

        it("prefers an explicit digest over the bare ID", () => {
            const digest = `sha256:${"e".repeat(64)}`;
            expect(parseImageRef(`${id}@${digest}`)).toEqual({
                registry: undefined,
                repository: "",
                tag: undefined,
                digest,
            });
        });

        it("does not treat a short sha256-prefixed ref as a bare ID", () => {
            expect(parseImageRef("sha256:v1").tag).toBe("v1");
        });
    });
});
