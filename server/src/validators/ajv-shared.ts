/**
 * The parts the two AJV validators (CycloneDX and OSV) share: the error
 * shape, the mapping from AJV's `ErrorObject` to it, schema loading from a
 * vendored-specifications directory, and the human-readable formatter.
 *
 * Each validator keeps its own AJV instance on purpose — CycloneDX is
 * draft-07 with `allErrors: true`, OSV is draft 2020-12 with
 * `allErrors: false` — so what lives here is everything except that choice.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { ErrorObject } from "ajv";

/** A validation error from a JSON-schema validator. */
export interface SchemaValidationError {
    path: string;
    message: string;
    keyword: string;
    params: Record<string, unknown>;
}

/** Result of a JSON-schema validation. */
export interface SchemaValidationResult {
    valid: boolean;
    errors: SchemaValidationError[];
}

/** Loads a JSON schema file from a specifications directory. */
export function loadSchemaFrom(dir: string, filename: string): object {
    const schemaContent = readFileSync(join(dir, filename), "utf-8");
    return JSON.parse(schemaContent);
}

/** Map AJV's error objects to the shared error shape. */
export function mapAjvErrors(errors: ErrorObject[] | null | undefined): SchemaValidationError[] {
    return (errors ?? []).map((error) => ({
        path: error.instancePath || "/",
        message: error.message ?? "Unknown validation error",
        keyword: error.keyword,
        params: error.params as Record<string, unknown>,
    }));
}

/**
 * Formats validation errors into a human-readable string
 */
export function formatValidationErrors(errors: SchemaValidationError[]): string {
    if (errors.length === 0) {
        return "No validation errors";
    }

    if (errors.length === 1) {
        const err = errors[0]!;
        return `${err.path}: ${err.message}`;
    }

    // For multiple errors, show first few with count
    const maxShown = 3;
    const shown = errors.slice(0, maxShown);
    const remaining = errors.length - maxShown;

    const formatted = shown.map((err) => `${err.path}: ${err.message}`).join("; ");

    if (remaining > 0) {
        return `${formatted} (and ${remaining} more error${remaining > 1 ? "s" : ""})`;
    }

    return formatted;
}
