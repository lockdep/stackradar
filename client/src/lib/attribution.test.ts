import { describe, it, expect } from "vitest";
import {
  attributionFromSearchParams,
  parseAttributionCookie,
  serializeAttributionCookie,
} from "./attribution";

describe("attributionFromSearchParams", () => {
  it("maps the click id and utm parameters, ignoring everything else", () => {
    expect(
      attributionFromSearchParams({
        rdt_cid: "abc",
        utm_source: "reddit",
        utm_campaign: "kubernetes-angle4",
        callbackUrl: "/",
      }),
    ).toEqual({ clickId: "abc", utmSource: "reddit", utmCampaign: "kubernetes-angle4" });
  });

  it("returns null when no attribution parameter is present", () => {
    expect(attributionFromSearchParams({ callbackUrl: "/" })).toBeNull();
    expect(attributionFromSearchParams({})).toBeNull();
  });

  it("takes the first value of a repeated key and drops blank or oversized values", () => {
    expect(
      attributionFromSearchParams({
        rdt_cid: ["first", "second"],
        utm_source: "   ",
        utm_medium: "x".repeat(256),
      }),
    ).toEqual({ clickId: "first" });
  });
});

describe("attribution cookie", () => {
  it("round-trips", () => {
    const attr = { clickId: "abc", utmSource: "reddit" };
    expect(parseAttributionCookie(serializeAttributionCookie(attr))).toEqual(attr);
  });

  it("rejects values that are not ours", () => {
    expect(parseAttributionCookie(undefined)).toBeNull();
    expect(parseAttributionCookie("not json")).toBeNull();
    expect(parseAttributionCookie('"a string"')).toBeNull();
    expect(parseAttributionCookie('{"other":"x"}')).toBeNull();
    expect(parseAttributionCookie('{"clickId":42}')).toBeNull();
  });
});
