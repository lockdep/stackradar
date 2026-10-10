/**
 * Comparing image tags, and knowing when not to.
 *
 * `base-image-recommendations.md` states the problem plainly: image tag
 * ordering is not a solved problem. `latest`, `20`, `20.18`, `20.18-slim`,
 * `20.18-alpine3.20` and `20-bookworm` are all tags of the same repository, and
 * only some pairs of them are ordered. This module's job is therefore **not**
 * to order tags. It is to decide which pairs are safely comparable and refuse
 * the rest, because the failure it exists to prevent is recommending a move
 * that quietly changes the base distribution under someone's application.
 *
 * The rule, and it is deliberately narrow:
 *
 *   1. Split a tag into a **version** and a **variant** — `20.18-alpine3.20`
 *      is version `20.18`, variant `alpine3.20`.
 *   2. Two tags are comparable only when their variants are **identical
 *      strings**. Not "similar", not "both Alpine". `alpine3.19` and
 *      `alpine3.20` are different base images, and a bump between them is a
 *      distro upgrade wearing a tag bump's clothes.
 *   3. Two tags are comparable only when their versions have the **same number
 *      of components**. `20` and `20.18` are not a pair: `20` is a moving
 *      pointer that already includes whatever `20.18` is, so "upgrade from 20
 *      to 20.18" is not an action, and "from 20.18 to 20" is a *loss* of
 *      pinning dressed up as a fix.
 *   4. Anything that is not a dotted numeric version — `latest`, `stable`,
 *      `edge`, a date, a git SHA — is comparable with nothing.
 *
 * Everything this refuses shows up in the UI as "ordering is ambiguous", which
 * the proposal requires be surfaced rather than resolved silently. Refusing
 * costs a recommendation we could have made; guessing costs the customer's
 * trust the first time we tell them to move from `-slim` to `-alpine`.
 */

/** A tag decomposed for comparison. */
export interface ParsedTag {
    /** The tag verbatim. */
    raw: string;
    /**
     * Numeric version components, or null when the tag does not lead with a
     * dotted numeric version. `v` and `V` prefixes are stripped — a repository
     * that tags `v1.2.3` is consistent about it, so the prefix is noise rather
     * than information.
     */
    version: number[] | null;
    /**
     * Everything after the version, minus the separating `-`. Empty string for
     * a bare version tag; that is a variant too — the *default* variant — and
     * it must not be conflated with `slim`.
     */
    variant: string;
    /**
     * Trailing non-numeric matter inside the version part, e.g. the `rc1` of
     * `1.2.3-rc1`. A pre-release is never recommended as an upgrade target.
     */
    prerelease: string | null;
}

const VERSION_HEAD = /^v?(\d+(?:\.\d+)*)/i;
const PRERELEASE = /^(alpha|beta|rc|dev|preview|snapshot|pre)/i;

/**
 * Split a tag into version and variant.
 *
 * The split is at the **first** `-` following the numeric head, which is the
 * convention every mainstream base image follows (`20.18-slim`,
 * `3.12-alpine`, `1.25.2-bookworm`). Tags that do not follow it parse with a
 * null version and are comparable with nothing, which is the correct outcome.
 */
export function parseTag(tag: string): ParsedTag {
    const trimmed = tag.trim();
    const head = VERSION_HEAD.exec(trimmed);

    if (!head) {
        return { raw: tag, version: null, variant: trimmed, prerelease: null };
    }

    const versionText = head[1]!;
    const rest = trimmed.slice(head[0].length);
    const version = versionText.split(".").map(Number);

    // `1.2.3rc1` and `1.2.3-rc1` are the same claim. Only the `-` form can be
    // told from a variant, so the suffix is tested against a known vocabulary
    // rather than assumed — `20.18-slim` must not read as a pre-release.
    const afterDash = rest.startsWith("-") ? rest.slice(1) : rest;
    if (afterDash !== "" && PRERELEASE.test(afterDash)) {
        return { raw: tag, version, variant: "", prerelease: afterDash };
    }

    return { raw: tag, version, variant: afterDash, prerelease: null };
}

/** Why two tags could not be ordered. Rendered verbatim to the user. */
export type IncomparableReason =
    | "not-a-version"
    | "different-variant"
    | "different-precision"
    | "prerelease";

export type TagComparison =
    | { comparable: true; /** −1, 0, 1 for a older/same/newer than b. */ order: number }
    | { comparable: false; reason: IncomparableReason };

/**
 * Order two tags of the same repository, or say why not.
 *
 * Note this never consults the registry and never resolves a digest. It is a
 * statement about two strings, which is all a tag is.
 */
export function compareTags(a: string, b: string): TagComparison {
    const left = parseTag(a);
    const right = parseTag(b);

    if (left.version === null || right.version === null) {
        return { comparable: false, reason: "not-a-version" };
    }
    if (left.prerelease !== null || right.prerelease !== null) {
        return { comparable: false, reason: "prerelease" };
    }
    if (left.variant !== right.variant) {
        return { comparable: false, reason: "different-variant" };
    }
    if (left.version.length !== right.version.length) {
        return { comparable: false, reason: "different-precision" };
    }

    for (let i = 0; i < left.version.length; i++) {
        const l = left.version[i]!;
        const r = right.version[i]!;
        if (l !== r) return { comparable: true, order: l < r ? -1 : 1 };
    }
    return { comparable: true, order: 0 };
}

/** Which component of the version moved — for saying what class of change this is. */
export type VersionBump = "major" | "minor" | "patch" | "none";

export function bumpKind(from: string, to: string): VersionBump {
    const a = parseTag(from).version;
    const b = parseTag(to).version;
    if (!a || !b) return "none";
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) {
            return i === 0 ? "major" : i === 1 ? "minor" : "patch";
        }
    }
    return "none";
}

/**
 * The newest tag strictly greater than `current`, among `candidates`.
 *
 * Returns the candidates it had to refuse alongside the answer, because
 * "we found nothing newer" and "we found three tags we could not order against
 * yours" are different states and the UI has to distinguish them — that is the
 * acceptance criterion about ambiguous ordering being surfaced.
 */
export interface BestTagResult {
    best: string | null;
    /** Comparable tags that were newer, newest first. */
    newer: string[];
    /** Tags refused, with the reason, so the UI can say what it skipped. */
    incomparable: Array<{ tag: string; reason: IncomparableReason }>;
}

export function bestNewerTag(current: string, candidates: string[]): BestTagResult {
    const newer: string[] = [];
    const incomparable: Array<{ tag: string; reason: IncomparableReason }> = [];

    for (const candidate of candidates) {
        if (candidate === current) continue;
        const cmp = compareTags(current, candidate);
        if (!cmp.comparable) {
            incomparable.push({ tag: candidate, reason: cmp.reason });
        } else if (cmp.order < 0) {
            newer.push(candidate);
        }
    }

    // Sort by the same comparison that admitted them, so the ordering shown is
    // the ordering that was reasoned about.
    newer.sort((x, y) => {
        const cmp = compareTags(x, y);
        return cmp.comparable ? -cmp.order : 0;
    });

    return { best: newer[0] ?? null, newer, incomparable };
}
