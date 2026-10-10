/** Longest advisory summary shown as a title before it is cut. OSV recommends
 *  120 characters; generated records (Chainguard's "applied in" package
 *  lists) run to the 512 the column holds. */
const MAX_TITLE_LENGTH = 140

/** An advisory summary cut to title length, ending in "..." when cut. Breaks
 *  at the last word boundary so a package name is never left half-written. */
export function vulnTitle(summary: string): string {
    const text = summary.trim()
    if (text.length <= MAX_TITLE_LENGTH) return text
    const cut = text.slice(0, MAX_TITLE_LENGTH)
    const lastSpace = cut.lastIndexOf(' ')
    const head = lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut
    return `${head.replace(/[\s,;:.]+$/, '')}...`
}
