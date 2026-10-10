/**
 * Which distro release lines are end-of-life — the data behind the
 * fixable/unfixable split in `remediation-workflow.md` phase 1.
 *
 * A null `fixedVersion` on a distro package means one of two unrelated things,
 * and collapsing them is what makes people stop trusting the number:
 *
 *   - the advisory has no fix published *yet* — wait and track;
 *   - the release line is EOL and never will — the action is "migrate the
 *     base image", which is different and larger work, not a dead end.
 *
 * `component_vulnerabilities.matchedEcosystem` (`Alpine:v3.16`) is the only
 * column that can tell them apart, and this module is the judgement call: is
 * that release line still receiving security fixes?
 *
 * ## Honesty rules
 *
 * - **Unknown is never EOL.** A family or release this table does not know is
 *   `null` — "we could not say" — and the caller must bucket it as
 *   awaiting-fix, the claim that does not state anything about the customer's
 *   base image. Rolling distros (Wolfi, Arch) and pure package registries
 *   (npm, PyPI) land here by construction: a registry has no release line to
 *   be EOL.
 * - **Dates, not booleans.** Entries carry the date support ends and the
 *   check compares against the clock, so a line whose support ends next month
 *   flips over without a code change — and a stale table errs toward
 *   "supported", the claim that creates no false "migrate your base image"
 *   work.
 *
 * The dates come from the distros' published schedules (as aggregated by
 * endoflife.date), vendored as of {@link EOL_DATA_AS_OF}. For LTS distros the
 * date used is the end of the *last* phase that ships security fixes to
 * non-paying users (Debian: LTS end; Ubuntu: standard support end — Pro is
 * handled separately below). Refreshing this table is a data edit, reviewed
 * like one.
 */

/**
 * When the vendored schedule was last checked against upstream.
 *
 * @public Nothing imports this — it is the provenance stamp for the data
 * below, kept exported (and knip-ignored via this tag) so refreshing the
 * table means updating it, reviewed like the data edit it documents.
 */
export const EOL_DATA_AS_OF = "2026-08-16";

/**
 * `family → release → date security fixes end`, families spelled as OSV
 * spells them in ecosystem strings and releases spelled as they appear
 * *after* normalisation (Alpine's `v` prefix stripped, Ubuntu's `:LTS`
 * suffix dropped).
 *
 * Dates in the future are deliberate: the runtime comparison is what decides,
 * and a line scheduled to die keeps working until it does.
 */
const EOL_DATES: Record<string, Record<string, string>> = {
    // Alpine supports each branch for ~2 years from release.
    Alpine: {
        "3.10": "2021-05-01",
        "3.11": "2021-11-01",
        "3.12": "2022-05-01",
        "3.13": "2022-11-01",
        "3.14": "2023-05-01",
        "3.15": "2023-11-01",
        "3.16": "2024-05-23",
        "3.17": "2024-11-22",
        "3.18": "2025-05-09",
        "3.19": "2025-11-01",
        "3.20": "2026-04-01",
        "3.21": "2026-11-01",
        "3.22": "2027-05-31",
    },
    // Debian: the date LTS ends — the last point a free security fix ships.
    Debian: {
        "8": "2020-06-30",
        "9": "2022-06-30",
        "10": "2024-06-30",
        "11": "2026-08-31",
        "12": "2028-06-30",
        "13": "2030-06-30",
    },
    // Ubuntu: end of standard support. Pro/ESM coverage is recognised by the
    // ecosystem string itself (`Ubuntu:Pro:…`), not by these dates.
    Ubuntu: {
        "14.04": "2019-04-25",
        "16.04": "2021-04-30",
        "18.04": "2023-05-31",
        "20.04": "2025-05-31",
        "21.10": "2022-07-14",
        "22.04": "2027-06-01",
        "22.10": "2023-07-20",
        "23.04": "2024-01-25",
        "23.10": "2024-07-11",
        "24.04": "2029-05-31",
        "24.10": "2025-07-11",
        "25.04": "2026-01-31",
    },
};

export interface EolVerdict {
    /** True when the release line stopped receiving security fixes. */
    eol: boolean;
    /** The line, normalised for display: `Alpine 3.16`. */
    releaseLine: string;
    /** When fixes ended (or end), ISO date. */
    eolDate: string;
}

/**
 * Normalise the release part of an OSV ecosystem string to the key
 * {@link EOL_DATES} uses.
 *
 * Alpine writes `v3.16`; Ubuntu writes `20.04:LTS` and `Pro:18.04:LTS`. The
 * Pro marker is meaningful — it says the advisory is scoped to a paid
 * coverage window that is, by definition, still shipping fixes — so a Pro
 * release is reported as supported rather than looked up.
 */
function releaseKey(family: string, release: string): string | null {
    if (family === "Alpine") {
        return release.startsWith("v") ? release.slice(1) : release;
    }
    if (family === "Ubuntu") {
        if (release.startsWith("Pro")) return null;
        const version = release.match(/^\d{2}\.\d{2}/);
        return version ? version[0] : null;
    }
    return release;
}

/**
 * Is this matched ecosystem an EOL release line?
 *
 * Returns `null` — "we could not say" — for anything the table does not cover:
 * no release part, unknown family, unknown release, Ubuntu Pro. Callers must
 * treat `null` as *not* EOL; see the module header.
 */
export function eolVerdict(
    matchedEcosystem: string | null | undefined,
    now: Date = new Date()
): EolVerdict | null {
    if (!matchedEcosystem) return null;

    const colon = matchedEcosystem.indexOf(":");
    if (colon === -1) return null;

    const family = matchedEcosystem.slice(0, colon).trim();
    const release = matchedEcosystem.slice(colon + 1).trim();
    if (!family || !release) return null;

    const releases = EOL_DATES[family];
    if (!releases) return null;

    const key = releaseKey(family, release);
    if (!key) return null;

    const eolDate = releases[key];
    if (!eolDate) return null;

    return {
        eol: now.getTime() >= new Date(`${eolDate}T00:00:00Z`).getTime(),
        releaseLine: `${family} ${key}`,
        eolDate,
    };
}
