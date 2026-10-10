import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

// Handle ESM/CJS interop - ajv and ajv-formats use CJS exports
const Ajv = AjvModule.default ?? AjvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
    loadSchemaFrom,
    mapAjvErrors,
    formatValidationErrors,
    type SchemaValidationResult,
} from "./ajv-shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Result of CycloneDX validation */
export type CycloneDxValidationResult = SchemaValidationResult;

export { formatValidationErrors };

const SCHEMA_DIR = join(__dirname, "../schemas/cyclonedx-specifications");

// Initialize AJV with the schema at module load time
const ajv = new Ajv({
    allErrors: true,      // Report all errors, not just the first one
    strict: false,        // Allow draft-07 schema features
    validateFormats: true,
});

// Add format validators (uri, date-time, email, etc.)
addFormats(ajv);

// Add missing format validators that aren't in ajv-formats
// These formats are used in the CycloneDX schema but not supported by ajv-formats
// We add them as permissive validators since they're not critical for validation
ajv.addFormat("iri-reference", true);  // IRI reference (internationalized URI)
ajv.addFormat("idn-email", true);       // Internationalized email

// Load and register referenced schemas first (order matters for $ref resolution)
const spdxSchema = loadSchemaFrom(SCHEMA_DIR, "spdx.schema.json");
const jsfSchema = loadSchemaFrom(SCHEMA_DIR, "jsf-0.82.schema.json");
ajv.addSchema(spdxSchema, "spdx.schema.json");
ajv.addSchema(jsfSchema, "jsf-0.82.schema.json");

/**
 * Supported CycloneDX spec versions, each compiled from its own vendored
 * schema. The scanner pins what it emits (`CYCLONEDX_SPEC_VERSION` in the
 * agent) to a member of this list; accepting a new version is a matter of
 * vendoring `bom-<v>.schema.json` and adding it here, and it must happen
 * *before* any agent is allowed to emit it — a fleet whose syft default moved
 * ahead of this list would have every upload answered with a 400.
 */
const SUPPORTED_SPEC_VERSIONS = ["1.6"] as const;
type SpecVersion = (typeof SUPPORTED_SPEC_VERSIONS)[number];

const validators = new Map(
    SUPPORTED_SPEC_VERSIONS.map((version) => [
        version,
        ajv.compile(loadSchemaFrom(SCHEMA_DIR, `bom-${version}.schema.json`)),
    ] as const),
);

function isSupportedSpecVersion(value: unknown): value is SpecVersion {
    return typeof value === "string" && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(value);
}

/**
 * Validates a CycloneDX SBOM against the official 1.6 JSON schema
 *
 * @param data - The parsed JSON data to validate
 * @returns Validation result with any errors
 *
 * @example
 * ```ts
 * const result = validateCycloneDx(sbomData);
 * if (!result.valid) {
 *     log.error({ errors: result.errors }, "CycloneDX validation failed");
 * }
 * ```
 */
export function validateCycloneDx(data: unknown): CycloneDxValidationResult {
    // Pick the schema by specVersion before validating against it. A document
    // with no specVersion is validated against the newest schema, which
    // reports the missing field itself.
    const specVersion = data && typeof data === "object" && "specVersion" in data
        ? (data as { specVersion: unknown }).specVersion
        : undefined;
    if (specVersion !== undefined && !isSupportedSpecVersion(specVersion)) {
        return {
            valid: false,
            errors: [{
                path: "/specVersion",
                message: `Unsupported CycloneDX version ${JSON.stringify(specVersion)}. Supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")}.`,
                keyword: "enum",
                params: { allowedValues: SUPPORTED_SPEC_VERSIONS },
            }],
        };
    }

    const newest: SpecVersion = SUPPORTED_SPEC_VERSIONS[SUPPORTED_SPEC_VERSIONS.length - 1]!;
    const validate = validators.get(specVersion ?? newest)!;
    const valid = validate(data);

    if (valid) {
        return { valid: true, errors: [] };
    }

    return { valid: false, errors: mapAjvErrors(validate.errors) };
}
