/**
 * OSV Test Fixture Loader
 *
 * Loads real-world OSV vulnerability JSON files from the osv-samples/ directory
 * for use in tests. Each sample includes the raw JSON, ecosystem directory
 * metadata, and pre-parsed fields.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateOsv, type OsvValidationError } from "../../src/validators/osv.validator.js";

/** Metadata about a sample vulnerability fixture */
export interface OsvSampleFixture {
    /** Filename (e.g., "GHSA-gq3g-666w-7h85.json") */
    filename: string;
    /** The vulnerability ID from the JSON */
    id: string;
    /** The ecosystem directory this would appear under in OSV storage */
    ecosystemDir: string;
    /** Raw file bytes (Buffer) */
    rawBytes: Buffer;
    /** Parsed JSON object */
    json: Record<string, unknown>;
    /** SHA256 hash of the raw bytes */
    sha256: Buffer;
    /** Modified timestamp from the JSON */
    modified: Date;
    /** Published timestamp (if present) */
    published: Date | undefined;
    /** Withdrawn timestamp (if present) */
    withdrawn: Date | undefined;
    /** Whether this sample has a withdrawn field */
    isWithdrawn: boolean;
    /** List of aliases (e.g., CVE IDs) */
    aliases: string[];
    /** Whether this sample passes OSV schema validation */
    isSchemaValid: boolean;
    /** Schema validation errors (empty if isSchemaValid is true) */
    validationErrors: OsvValidationError[];
    /** Human-readable description of why this sample is interesting */
    description: string;
}

/**
 * Mapping of sample files to their ecosystem directories.
 *
 * In the real OSV storage, files are organized as {ecosystem}/{id}.json.
 * Since the all.zip extraction may flatten this, we maintain the mapping here.
 */
const SAMPLE_ECOSYSTEM_MAP: Record<string, { ecosystemDir: string; description: string }> = {
    "GHSA-gq3g-666w-7h85.json": {
        ecosystemDir: "Packagist",
        description: "Packagist/PHP advisory with CVSS severity, many affected versions, detailed markdown description",
    },
    "GHSA-4m7p-55jm-3vwv.json": {
        ecosystemDir: "Maven",
        description: "Maven/Jenkins advisory with multiple affected version ranges on the same package",
    },
    "PYSEC-2006-1.json": {
        ecosystemDir: "PyPI",
        description: "Older PyPI vulnerability (2006) with minimal fields, no severity/CVSS",
    },
    "GO-2020-0001.json": {
        ecosystemDir: "Go",
        description: "Go advisory with ecosystem_specific.imports, credits field, SEMVER range",
    },
    "CVE-2023-22745.json": {
        ecosystemDir: "cve-osv",
        description: "Generic CVE with GIT range type (commit hashes), related field, severity/CVSS",
    },
    "MAL-2022-5134.json": {
        ecosystemDir: "npm",
        description: "Malware advisory for npm package, malicious-packages-origins in database_specific",
    },
    "TEST-WITHDRAWN-001.json": {
        ecosystemDir: "npm",
        description: "Synthetic withdrawn vulnerability for testing the withdrawn code path",
    },
};

const SAMPLES_DIR = join(import.meta.dirname, "osv-samples");

function computeSha256(data: Buffer): Buffer {
    return createHash("sha256").update(data).digest();
}

function loadSample(filename: string): OsvSampleFixture {
    const meta = SAMPLE_ECOSYSTEM_MAP[filename];
    if (!meta) {
        throw new Error(`No ecosystem mapping for sample: ${filename}`);
    }

    const rawBytes = readFileSync(join(SAMPLES_DIR, filename));
    const json = JSON.parse(rawBytes.toString("utf8")) as Record<string, unknown>;

    const id = json["id"] as string;
    if (!id) {
        throw new Error(`Sample ${filename} missing 'id' field`);
    }

    const modifiedStr = json["modified"] as string;
    if (!modifiedStr) {
        throw new Error(`Sample ${filename} missing 'modified' field`);
    }

    const publishedStr = json["published"] as string | undefined;
    const withdrawnStr = json["withdrawn"] as string | undefined;

    const validation = validateOsv(json);

    return {
        filename,
        id,
        ecosystemDir: meta.ecosystemDir,
        rawBytes,
        json,
        sha256: computeSha256(rawBytes),
        modified: new Date(modifiedStr),
        published: publishedStr ? new Date(publishedStr) : undefined,
        withdrawn: withdrawnStr ? new Date(withdrawnStr) : undefined,
        isWithdrawn: withdrawnStr !== undefined,
        aliases: (json["aliases"] as string[] | undefined) ?? [],
        isSchemaValid: validation.valid,
        validationErrors: validation.errors,
        description: meta.description,
    };
}

// ===== Lazy-loaded cache =====
let _allSamples: OsvSampleFixture[] | null = null;

/**
 * Load all OSV sample fixtures.
 * Results are cached after the first call.
 */
export function loadAllOsvSamples(): OsvSampleFixture[] {
    if (_allSamples) return _allSamples;

    const files = readdirSync(SAMPLES_DIR).filter((f) => f.endsWith(".json"));
    _allSamples = files.map(loadSample);
    return _allSamples;
}

/**
 * Load a specific sample by its vulnerability ID.
 */
export function loadOsvSample(vulnId: string): OsvSampleFixture {
    const samples = loadAllOsvSamples();
    const sample = samples.find((s) => s.id === vulnId);
    if (!sample) {
        throw new Error(`No OSV sample found with ID: ${vulnId}. Available: ${samples.map((s) => s.id).join(", ")}`);
    }
    return sample;
}

/**
 * Load only the withdrawn sample(s).
 */
export function loadWithdrawnSamples(): OsvSampleFixture[] {
    return loadAllOsvSamples().filter((s) => s.isWithdrawn);
}

/**
 * Load only non-withdrawn (active) samples.
 */
export function loadActiveSamples(): OsvSampleFixture[] {
    return loadAllOsvSamples().filter((s) => !s.isWithdrawn);
}

/**
 * Load only samples that pass OSV schema validation.
 */
export function loadSchemaValidSamples(): OsvSampleFixture[] {
    return loadAllOsvSamples().filter((s) => s.isSchemaValid);
}

/**
 * Load only samples that have schema validation errors.
 */
