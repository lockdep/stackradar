import type { Image, SortColumn, SortDirection } from '@/types/container';
import { severityScore } from '@/utils/containerUtils';

/**
 * When the image was built — the `created` field of its config, as the
 * scanner reports it (0.4.0 and later) — or `null` when there is nothing
 * honest to show. Reproducible builds stamp a placeholder (1970, 1980), and
 * an age of fifty years would be a fact about the build tool, not the image;
 * anything before container images existed is treated as absent.
 */
const EARLIEST_BUILD = Date.UTC(2013, 0, 1);
export function builtAt(image: Image): string | null {
    const created = image.metadata?.created;
    if (!created) return null;
    const time = new Date(created).getTime();
    return Number.isNaN(time) || time < EARLIEST_BUILD ? null : created;
}

/**
 * The containers list's ordering rules, over images: unscanned sorts below
 * zero for risk and severity, and the name breaks every tie. The hook's
 * container-only column (`onImage`) falls through to the name.
 */
export function compareImages(a: Image, b: Image, column: SortColumn | null, direction: SortDirection): number {
    const byName =
        (a.repository ?? '').localeCompare(b.repository ?? '') ||
        (a.clusterName ?? '').localeCompare(b.clusterName ?? '') ||
        a.digest.localeCompare(b.digest);
    const signed = (delta: number) => (direction === 'desc' ? -delta : delta);

    if (column === 'risk') {
        return signed((a.risk?.score ?? -1) - (b.risk?.score ?? -1)) || byName;
    }
    if (column === 'severity') {
        return signed(severityScore(a.vulnerabilities) - severityScore(b.vulnerabilities)) || byName;
    }
    if (column === 'scannedAt') {
        const at = new Date(a.lastMatchedAt ?? a.scannedAt ?? 0).getTime();
        const bt = new Date(b.lastMatchedAt ?? b.scannedAt ?? 0).getTime();
        return signed(at - bt) || byName;
    }
    if (column === 'firstSeen') {
        return signed(new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime()) || byName;
    }
    if (column === 'built') {
        // No build date sorts last either way: unknown is neither old nor new.
        const ab = builtAt(a);
        const bb = builtAt(b);
        if (ab === null || bb === null) return ab === bb ? byName : ab === null ? 1 : -1;
        return signed(new Date(ab).getTime() - new Date(bb).getTime()) || byName;
    }
    return column === 'name' && direction === 'desc' ? -byName : byName;
}
