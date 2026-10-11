import { describe, it, expect } from "vitest";
import { renderKubeVersion } from "../../../src/chart-render/kube-version.js";

describe("renderKubeVersion", () => {
    it("renders with nothing when no range is declared", () => {
        expect(renderKubeVersion(null)).toBeNull();
        expect(renderKubeVersion(undefined)).toBeNull();
        expect(renderKubeVersion("")).toBeNull();
    });

    it("uses the minimum of an unbounded range — the one version it provably includes", () => {
        expect(renderKubeVersion(">=1.19.0-0")).toBe("1.19.0");
        expect(renderKubeVersion(">=1.21-0")).toBe("1.21.0");
    });

    it("uses the middle minor of a bounded range", () => {
        // Masterminds comma-AND, as charts actually write it.
        expect(renderKubeVersion(">=1.21.0-0, <1.29.0")).toBe("1.25.0");
        expect(renderKubeVersion(">=1.20.0 <=1.22.0")).toBe("1.21.0");
    });

    it("falls back to the minimum when the bound crosses a major", () => {
        expect(renderKubeVersion(">=1.19.0 <2.0.0")).toBe("1.19.0");
    });

    it("refuses an unparseable range rather than inventing a version", () => {
        expect(renderKubeVersion("not-a-range")).toBeNull();
    });
});
