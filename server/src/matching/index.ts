/**
 * Vulnerability matching — the public surface of `matching/`.
 *
 * The rest of the server imports from here and nowhere deeper (the module's
 * own unit tests may reach inside). Everything behind this file (identity
 * rules, ecosystem tables, version comparators) is free to change shape as
 * long as this surface holds.
 *
 * The usual entry point is two lines:
 *
 *   const matcher = createMatcher(createDrizzleCandidateStore(db));
 *   const matches = await matcher.findVulnerabilitiesBatch(components);
 */

export { affectedPackageKey, parsePurl, repairGluedQualifiers } from "./identity.js";

export {
    DISTRO_PURL_TYPES,
    ecosystemMatchesDistro,
    isDistroPurlType,
    parseEcosystem,
    purlTypeForFamily,
    releaseVersion,
    schemeForPurlType,
} from "./ecosystem.js";

export { compare } from "./version/index.js";
export type { Scheme } from "./version/index.js";

export { evaluateAffected } from "./ranges.js";

export { createMatcher } from "./match.js";
export type { Matcher, MatchConfidence } from "./match.js";

export { createDrizzleCandidateStore } from "./store.js";
