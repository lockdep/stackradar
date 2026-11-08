import type { Response } from "express";
import { vulnerabilityRepository } from "../repositories/index.js";
import type { VulnerabilityListOptions, VulnerabilityScope } from "../repositories/vulnerability.repository.js";
import { findingsCsv, findingsCsvFilename } from "../lib/findings-csv.js";

/**
 * `?format=csv` on a vulnerability list: the same scope and filters the
 * JSON page was asked with, every matching finding rather than a page of
 * advisories, as a file download. The three list handlers (organization,
 * cluster, image) each hand their scope here so the file is one shape
 * wherever it was downloaded from.
 *
 * Built in memory rather than streamed: the largest organizations hold tens
 * of thousands of findings, a few megabytes of text, and the rows are
 * ordered in one query the same way the list is.
 */
export async function sendFindingsCsv(
    res: Response,
    scope: VulnerabilityScope,
    options: VulnerabilityListOptions,
    scopeName: string,
): Promise<void> {
    const rows = await vulnerabilityRepository.findFindingsForExport(scope, options);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${findingsCsvFilename(scopeName)}"`);
    res.send(findingsCsv(rows));
}
