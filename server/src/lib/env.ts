/**
 * Environment-variable readers shared by every module that carries its own
 * config (the four sync pipelines, chart-render, platform-scan).
 *
 * An unset variable and an empty string both mean "use the default": `FOO=`
 * in a manifest or `.env` is someone clearing an override, not asking for
 * `Number("") === 0`. A value that does not parse falls back too — a typo'd
 * override degrading to the shipped default is better than NaN reaching a
 * timeout or batch size.
 */

export function envString(key: string, fallback: string): string {
    const raw = process.env[key];
    return raw == null || raw === "" ? fallback : raw;
}

/** Accepts any finite number, including 0 — several syncs document "0 disables". */
export function envNumber(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw == null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Like `envNumber`, but rejects zero and negatives. For values where 0 is not
 * a mode but a misconfiguration — byte ceilings, timeouts, per-run caps
 * (chart-render, platform-scan) — where "disable the limit" must not be one
 * `0` away from "cap everything at nothing".
 */
export function envPositiveNumber(key: string, fallback: number): number {
    const value = envNumber(key, fallback);
    return value > 0 ? value : fallback;
}
