/**
 * Split `items` into consecutive slices of at most `size`, in order. The last
 * slice may be shorter; an empty input yields no slices. Used by the bulk
 * upserts, whose batch size exists because Postgres's 65535-parameter ceiling
 * is per statement, not per transaction.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}
