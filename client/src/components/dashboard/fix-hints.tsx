import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { FixesResponse, FixListItem, NoRecommendationItem, NoRecommendationReason } from '@/types/fixes';

/**
 * The org's upgrade list, keyed the way the Dashboard's blocks ask of it:
 * "is there a move for this image", "for this release", and — when there is
 * neither — "why not". The list is the Fixes page's (`GET
 * /api/remediation/fixes`), fetched once by the page; the server ranks it, so
 * the first move for a key is its best one.
 */
export type FixIndex = {
    byImage: ReadonlyMap<string, FixListItem>;
    byRelease: ReadonlyMap<string, FixListItem>;
    noMoveByImage: ReadonlyMap<string, NoRecommendationItem>;
};

export const EMPTY_FIX_INDEX: FixIndex = { byImage: new Map(), byRelease: new Map(), noMoveByImage: new Map() };

export function indexFixes(response: FixesResponse | null | undefined): FixIndex {
    if (!response) return EMPTY_FIX_INDEX;
    const byImage = new Map<string, FixListItem>();
    const byRelease = new Map<string, FixListItem>();
    for (const fix of response.fixes) {
        if (fix.target.type === 'image') {
            if (!byImage.has(fix.target.imageId)) byImage.set(fix.target.imageId, fix);
        } else if (!byRelease.has(fix.target.releaseId)) {
            byRelease.set(fix.target.releaseId, fix);
        }
    }
    return {
        byImage,
        byRelease,
        noMoveByImage: new Map(response.noRecommendation.map((item) => [item.imageId, item])),
    };
}

/** The best move known for an image: its own, else the chart's of a release running it. */
export function fixFor(
    index: FixIndex,
    imageId: string,
    releaseIds: readonly (string | null)[] = [],
): FixListItem | undefined {
    const own = index.byImage.get(imageId);
    if (own) return own;
    for (const id of releaseIds) {
        const fix = id ? index.byRelease.get(id) : undefined;
        if (fix) return fix;
    }
    return undefined;
}

export function fixHref(fix: FixListItem): string {
    return fix.target.type === 'image' ? `/images/${fix.target.imageId}` : `/releases/${fix.target.releaseId}`;
}

/** Why there is no move, short enough for a table cell. The Fixes page has the full sentence. */
const NO_MOVE_SHORT: Record<NoRecommendationReason, string> = {
    'up-to-date': 'Newest scanned tag',
    'no-candidates': 'No other tag scanned',
    'not-measured': 'Newer version not scanned yet',
    'ambiguous-ordering': 'Tags cannot be ordered',
    eol: 'End-of-life base',
};

const NO_MOVE_LONG: Record<NoRecommendationReason, string> = {
    'up-to-date':
        'This is already the newest tag of the repository anyone here has scanned, so there is no measured move yet.',
    'no-candidates': 'No other tag of this repository has been scanned here, so there is nothing to compare it with.',
    'not-measured': 'A newer version is known, but nothing has scanned what it deploys yet.',
    'ambiguous-ordering': 'Other tags exist, but none of the same variant and precision to order against this one.',
    eol: 'The findings sit on a release line that ships no more fixes: the move is a base-image migration, not a tag bump.',
};

/** What a move does, as a verb phrase: "Move to v2.44.0", "Rebuild on alpine:3.22", "Chart 9.1.0 available". */
function moveLabel(fix: FixListItem): string {
    if (fix.kind === 'base') return `Rebuild on ${fix.to}`;
    if (fix.kind === 'chart') return fix.measured ? `Upgrade chart to ${fix.to}` : `Chart ${fix.to} available`;
    return `Move to ${fix.to}`;
}

/** What the move buys, only when it was measured — an unmeasured move may only say it exists. */
function clearsLabel(fix: FixListItem): string | null {
    if (!fix.measured || !fix.cleared) return null;
    const { findings, high } = fix.cleared;
    const base = `clears ${findings.toLocaleString()} ${findings === 1 ? 'finding' : 'findings'}`;
    return high > 0 ? `${base}, ${high.toLocaleString()} high or critical` : base;
}

/**
 * The fix for one image, in a table cell: the move and a way to it, or the
 * package version to rebuild with, or the short reason there is neither. A
 * dash only when nothing is known at all.
 */
export function FixCellHint({
    index,
    imageId,
    releaseIds,
    packageFix,
}: {
    index: FixIndex;
    imageId: string;
    releaseIds?: readonly (string | null)[];
    /** `next 16.3.3` — the version the advisory says fixes it in this image, when the upgrade list has no move. */
    packageFix?: string | null;
}) {
    const fix = fixFor(index, imageId, releaseIds);
    if (fix) {
        const clears = clearsLabel(fix);
        return (
            <Link
                href={fixHref(fix)}
                onClick={(e) => e.stopPropagation()}
                title={
                    clears
                        ? `${moveLabel(fix)} — ${clears}`
                        : `${moveLabel(fix)} — not measured yet: a newer version exists, what it clears is unknown`
                }
                className="inline-flex items-center gap-1 whitespace-nowrap text-accent hover:underline"
            >
                {moveLabel(fix)}
                {fix.bump === 'major' && <Badge variant="attention">major</Badge>}
            </Link>
        );
    }
    const none = index.noMoveByImage.get(imageId);
    if (none?.control === 'third-party') {
        return (
            <span className="text-ink-muted" title={NO_MOVE_LONG[none.reason]}>
                Waiting on upstream
            </span>
        );
    }
    /* No measured move, but the advisory names the version: for an image the
       org builds that is the whole fix. */
    if (packageFix) {
        return (
            <span
                className="whitespace-nowrap text-ink-secondary"
                title={`No measured image upgrade${none ? ` — ${NO_MOVE_LONG[none.reason]}` : ''} Rebuilding the image with ${packageFix} clears this finding.`}
            >
                Rebuild with <span className="font-mono text-success">{packageFix}</span>
            </span>
        );
    }
    if (none) {
        return (
            <span className="text-ink-muted" title={NO_MOVE_LONG[none.reason]}>
                {NO_MOVE_SHORT[none.reason]}
            </span>
        );
    }
    return <span className="text-ink-faint">—</span>;
}

/**
 * The fix for one image as a sentence — the line an unfolded row ends its
 * "what is wrong" with. `packageFixes` is the fallback when there is no
 * measured move: the versions the advisories say fix it, which is a rebuild
 * for an image the org builds and a wait for one it does not.
 */
export function FixLine({
    index,
    imageId,
    releaseIds,
    thirdParty,
    packageFixes,
    imageHref,
}: {
    index: FixIndex;
    imageId: string;
    releaseIds?: readonly (string | null)[];
    /** Null when the block does not know who builds the image. */
    thirdParty: boolean | null;
    /** `openssl 3.3.7-r1` — every fixed version the listed findings state, deduplicated. */
    packageFixes: string[];
    imageHref: string;
}) {
    const fix = fixFor(index, imageId, releaseIds);
    const none = index.noMoveByImage.get(imageId);
    const isThirdParty = thirdParty ?? (fix?.control === 'third-party' || none?.control === 'third-party');
    const bumps =
        packageFixes.length > 0
            ? packageFixes.slice(0, 3).join(', ') +
              (packageFixes.length > 3 ? ` and ${packageFixes.length - 3} more` : '')
            : null;

    let body: React.ReactNode;
    if (fix) {
        const clears = clearsLabel(fix);
        body = (
            <>
                <Link
                    href={fixHref(fix)}
                    className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                >
                    {moveLabel(fix)}
                    <ArrowRight aria-hidden="true" className="size-3" />
                </Link>
                {fix.bump === 'major' && <Badge variant="attention">major</Badge>}
                <span className="text-ink-muted">
                    {clears ?? 'A newer version exists; what it clears has not been measured.'}
                </span>
            </>
        );
    } else if (bumps) {
        body = (
            <>
                <span className="text-ink-secondary">
                    {isThirdParty ? (
                        <>
                            Fixed upstream in <span className="font-mono">{bumps}</span> — waiting on an image release
                            that carries it.
                        </>
                    ) : (
                        <>
                            Update <span className="font-mono">{bumps}</span> and rebuild the image.
                        </>
                    )}
                </span>
                {none && <span className="text-ink-muted">{NO_MOVE_LONG[none.reason]}</span>}
                <Link href={imageHref} className="inline-flex items-center gap-1 text-accent hover:underline">
                    Image page
                    <ArrowRight aria-hidden="true" className="size-3" />
                </Link>
            </>
        );
    } else {
        body = (
            <span className="text-ink-muted">
                {none
                    ? NO_MOVE_LONG[none.reason]
                    : 'No advisory states a fix version yet, and no newer version is known.'}
            </span>
        );
    }

    return (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-ink">How to fix</span>
            {body}
        </p>
    );
}
