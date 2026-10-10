import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// Handle ESM/CJS interop - ajv and ajv-formats use CJS exports
const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
    loadSchemaFrom,
    mapAjvErrors,
    formatValidationErrors,
    type SchemaValidationError,
    type SchemaValidationResult,
} from "./ajv-shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Represents a validation error from the OSV schema validator */
export type OsvValidationError = SchemaValidationError;

/** Result of OSV validation */
export type OsvValidationResult = SchemaValidationResult;

/**
 * Formats OSV validation errors into a human-readable string
 */
export const formatOsvValidationErrors = formatValidationErrors;

const SCHEMA_DIR = join(__dirname, "../schemas/osv-specifications");

// Initialize AJV with draft 2020-12 support (required by the OSV schema)
const ajv = new Ajv2020({
    allErrors: false,     // Stop at first error to avoid many error objects per invalid record
    strict: false,        // Allow extra schema features without warning
    validateFormats: true,
});

// Add format validators (uri, date-time, etc.)
addFormats(ajv);

// Load and compile the OSV schema (self-contained, no external $ref)
const osvSchema = loadSchemaFrom(SCHEMA_DIR, "osv.schema.json");
const validate = ajv.compile(osvSchema);

/**
 * Validates an OSV vulnerability record against the official JSON schema.
 *
 * The OSV schema is backward-compatible across versions (changes are additive),
 * so the latest schema.json validates records from any prior version.
 *
 * @param data - The parsed JSON data to validate
 * @returns Validation result with any errors
 *
 * @example
 * ```ts
 * const result = validateOsv(osvRecord);
 * if (!result.valid) {
 *     log.error({ errors: result.errors }, "OSV validation failed");
 * }
 * ```
 */
const UBUNTU_SEVERITY_SCORES = new Set([
    "negligible",
    "low",
    "medium",
    "high",
    "critical",
]);

/**
 * Ubuntu CVEs often omit the "type" field in severity entries,
 * using bare scores like {"score": "medium"} instead of
 * {"type": "Ubuntu", "score": "medium"}. This normalizes those
 * entries so they pass schema validation.
 */
function normalizeUbuntuSeverity(data: unknown): unknown {
    if (
        typeof data !== "object" ||
        data === null ||
        !("id" in data) ||
        typeof (data as Record<string, unknown>).id !== "string"
    ) {
        return data;
    }

    const record = data as Record<string, unknown>;
    if (!(record.id as string).startsWith("UBUNTU-")) {
        return data;
    }

    const normalizeSeverityArray = (severity: unknown): unknown => {
        if (!Array.isArray(severity)) return severity;
        return severity.map((entry) => {
            if (
                typeof entry === "object" &&
                entry !== null &&
                "score" in entry &&
                !("type" in entry) &&
                UBUNTU_SEVERITY_SCORES.has((entry as Record<string, unknown>).score as string)
            ) {
                return { type: "Ubuntu", ...entry };
            }
            return entry;
        });
    };

    const normalized = { ...record };

    if (Array.isArray(normalized.severity)) {
        normalized.severity = normalizeSeverityArray(normalized.severity);
    }

    if (Array.isArray(normalized.affected)) {
        normalized.affected = (normalized.affected as Record<string, unknown>[]).map(
            (affected) => {
                if (Array.isArray(affected.severity)) {
                    return { ...affected, severity: normalizeSeverityArray(affected.severity) };
                }
                return affected;
            },
        );
    }

    return normalized;
}

const SUPPORTED_MAJOR_VERSION = 1;

export function validateOsv(data: unknown): OsvValidationResult {
    const normalized = normalizeUbuntuSeverity(data);
    const valid = validate(normalized);

    const errors: SchemaValidationError[] = valid ? [] : mapAjvErrors(validate.errors);

    if (
        typeof data === "object" &&
        data !== null &&
        "schema_version" in data &&
        typeof (data as Record<string, unknown>).schema_version === "string"
    ) {
        const version = (data as Record<string, unknown>).schema_version as string;
        const major = parseInt(version.split(".")[0] ?? "", 10);
        if (isNaN(major) || major !== SUPPORTED_MAJOR_VERSION) {
            errors.push({
                path: "/schema_version",
                message: `Unsupported schema_version "${version}"; supported major version is ${SUPPORTED_MAJOR_VERSION}`,
                keyword: "schema_version",
                params: { version },
            });
        }
    }

    return { valid: valid && errors.length === 0, errors };
}
