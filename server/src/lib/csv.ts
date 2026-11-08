/**
 * The CSV the findings export is written in: RFC 4180 (comma-separated,
 * CRLF line ends, double quotes doubled inside a quoted cell) with the two
 * conventions a spreadsheet needs on top of it.
 *
 * A UTF-8 byte-order mark opens the document: without it Excel reads the
 * file as the system code page and a package summary's `é` arrives as `Ã©`.
 * And a cell a spreadsheet would *evaluate* is marked as text. Package
 * names and advisory summaries are tenant-shaped input — the mirror carries
 * whatever OSV published, the SBOM whatever syft found — and a CSV opened in
 * a spreadsheet is the one place `=HYPERLINK(...)` or `@SUM(...)` in one of
 * them would run. The apostrophe is the mark Excel itself uses for a
 * literal, so the cell still reads as the text it is.
 */
export type CsvCell = string | number | boolean | null | undefined;

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    if (typeof value === "boolean") return value ? "true" : "false";
    const text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
    return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole document: the header row, then one line per row, CRLF-terminated. */
export function csvDocument(header: readonly string[], rows: Iterable<readonly CsvCell[]>): string {
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) lines.push(row.map(csvCell).join(","));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
}
