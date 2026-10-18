/**
 * The admin dashboard's System tab: what this process is and how it is
 * configured, as one read-only report.
 *
 * The audience is the operator asking "what version, what edition, which
 * ecosystems, which knobs, is the schema current" — one screen instead of
 * `kubectl describe`, a `.env` file and two `SELECT`s on the journals. Every
 * value here is an *effective* value, resolved by the same module that the
 * running code reads it through (`config/`, `edition.ts`, `topology.ts`,
 * `lib/logger.ts`), so the report cannot disagree with the behaviour.
 *
 * Never a secret. The service key, the database URL, the vault key and the
 * bootstrap scanner key do not appear; where one of them matters to the
 * operator the row says only that it is set.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { defaultMigrationsFolder } from "../db/migrate.js";
import { config, integrations } from "../config/index.js";
import { IMAGE_GC_RETENTION_DAYS } from "../config/image-gc.js";
import { edition, ENV_VAR as EDITION_ENV_VAR, type Edition } from "../edition.js";
import { topology, TOPOLOGY_ENV_VAR, type Topology } from "../topology.js";
import { SERVER_VERSION } from "../lib/server-version.js";
import { logger } from "../lib/logger.js";
import { BOOTSTRAP_CLUSTER_ID_VAR } from "../lib/bootstrap-cluster.js";
import { ECOSYSTEMS_ENV_VAR, parseEcosystems } from "../osv-sync/ecosystems.js";
import { adminStatusRepository } from "../repositories/admin-status.repository.js";

export interface ConfigRow {
    /** The environment variable, as the operator would set it. */
    key: string;
    /** The effective value, rendered — never a secret. */
    value: string;
    /** `set` when the variable is present and non-empty; `default` when the value is the shipped one. */
    source: "set" | "default";
}

export interface MigrationChain {
    /** Rows in the journal table; `null` when the table does not exist (the chain has never run). */
    applied: number | null;
    /** The newest applied migration's folder timestamp, which is what the migrator orders on. */
    latestAppliedAt: string | null;
}

export interface ServerMigrationChain extends MigrationChain {
    /** The journal entry matching `latestAppliedAt`, by its `when`; null when nothing is applied or the entry is unknown. */
    latestTag: string | null;
    /** Entries in this build's `drizzle/meta/_journal.json`. */
    chainLength: number;
    /** The chain's newest tag — what "current" means for this build. */
    chainLatestTag: string | null;
    /** Nothing in this build's chain is unapplied. */
    current: boolean;
}

export interface AdminSystemReport {
    build: {
        /** `package.json` version, plus the short git sha when the image was built with one. */
        version: string;
        node: string;
        startedAt: string;
        uptimeSeconds: number;
    };
    edition: { value: Edition; source: ConfigRow["source"] };
    topology: { value: Topology; source: ConfigRow["source"] };
    config: ConfigRow[];
    mirror: {
        /** `OSV_ECOSYSTEMS` as resolved; null = the whole corpus. */
        configuredEcosystems: string[] | null;
        /** What the live generation carries; null = everything; undefined = no state row yet. */
        liveEcosystems: string[] | null | undefined;
        /** The live mirror carries what is configured. False means the next `--bootstrap-if-needed` rebuilds. */
        matchesConfig: boolean;
    };
    migrations: {
        /** `drizzle.__drizzle_migrations` — the server's chain. */
        server: ServerMigrationChain;
        /** `auth.__drizzle_migrations` — the client's chain. The server has no journal to judge it against; the BFF adds that. */
        auth: MigrationChain;
    };
}

function isSet(name: string): boolean {
    const raw = process.env[name];
    return raw != null && raw.trim() !== "";
}

function row(key: string, value: string): ConfigRow {
    return { key, value, source: isSet(key) ? "set" : "default" };
}

/** A secret's row: only whether it is set. The value is the one word, never the variable's contents. */
function secretRow(key: string): ConfigRow {
    return { key, value: isSet(key) ? "configured" : "not set", source: isSet(key) ? "set" : "default" };
}

interface JournalEntry {
    when: number;
    tag: string;
}

/**
 * This build's chain, from the same `drizzle/meta/_journal.json` the
 * migrator reads. Unreadable (a packaging mistake) degrades to an empty
 * chain and `current: false` rather than refusing the whole report.
 */
function readServerJournal(): JournalEntry[] {
    try {
        const raw = readFileSync(join(defaultMigrationsFolder(), "meta", "_journal.json"), "utf-8");
        const journal = JSON.parse(raw) as { entries?: Array<{ when?: unknown; tag?: unknown }> };
        return (journal.entries ?? [])
            .filter((e): e is { when: number; tag: string } => typeof e.when === "number" && typeof e.tag === "string")
            .map((e) => ({ when: e.when, tag: e.tag }));
    } catch (error) {
        logger.warn({ err: error }, "admin system report: could not read the migration journal");
        return [];
    }
}

/**
 * One journal table's state, by name. Drizzle's `__drizzle_migrations`
 * stores each applied entry's folder timestamp in `created_at` (bigint ms),
 * and orders on it; it is the only key the two sides share. `to_regclass`
 * first, because a fresh database that has only ever run one of the two
 * chains has no table for the other, and that is a fact to report, not an
 * error to throw.
 */
async function readChain(schemaName: string): Promise<MigrationChain> {
    const qualified = `${schemaName}.__drizzle_migrations`;
    const [exists] = await db.execute<{ present: boolean }>(
        sql`SELECT to_regclass(${qualified}) IS NOT NULL AS present`,
    );
    if (!exists?.present) return { applied: null, latestAppliedAt: null };

    const [state] = await db.execute<{ applied: number; latest: string | null }>(
        sql`SELECT count(*)::int AS applied, max(created_at)::text AS latest FROM ${sql.identifier(schemaName)}.__drizzle_migrations`,
    );
    const latestMs = state?.latest != null ? Number(state.latest) : null;
    return {
        applied: Number(state?.applied ?? 0),
        latestAppliedAt: latestMs != null && Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    };
}

async function readServerChain(): Promise<ServerMigrationChain> {
    const [chain, journal] = await Promise.all([readChain("drizzle"), Promise.resolve(readServerJournal())]);
    const newest = journal[journal.length - 1] ?? null;
    const latestMs = chain.latestAppliedAt ? new Date(chain.latestAppliedAt).getTime() : null;
    const latestEntry = latestMs == null ? null : (journal.find((e) => e.when === latestMs) ?? null);
    return {
        ...chain,
        latestTag: latestEntry?.tag ?? null,
        chainLength: journal.length,
        chainLatestTag: newest?.tag ?? null,
        // The migrator applies every entry newer than the last applied row,
        // so "current" is exactly "the newest entry is not newer than that".
        current: newest !== null && latestMs !== null && latestMs >= newest.when,
    };
}

function ecosystemsLabel(list: string[] | null): string {
    return list === null ? "everything" : list.join(", ");
}

function sameScope(a: string[] | null, b: string[] | null): boolean {
    if (a === null || b === null) return a === b;
    return a.length === b.length && a.every((x) => b.includes(x));
}

export async function getSystemReport(): Promise<AdminSystemReport> {
    const [serverChain, authChain, osv] = await Promise.all([
        readServerChain(),
        readChain("auth"),
        adminStatusRepository.getOsvState(),
    ]);

    const configuredEcosystems = parseEcosystems(process.env[ECOSYSTEMS_ENV_VAR], edition);
    const liveEcosystems = osv ? (osv.ecosystems ?? null) : undefined;

    const uptimeSeconds = Math.floor(process.uptime());

    const rows: ConfigRow[] = [
        row(ECOSYSTEMS_ENV_VAR, ecosystemsLabel(configuredEcosystems)),
        row("IMAGE_GC_RETENTION_DAYS", `${IMAGE_GC_RETENTION_DAYS} days`),
        row("SCANNER_MIN_VERSION", config.scanner.minVersion || "none — every scanner version is accepted"),
        row("ARTIFACT_HUB_SYNC_ENABLED", integrations.artifactHubSync ? "true" : "false"),
        row("APP_URL", config.appUrl),
        row("PUBLIC_API_URL", config.publicApiUrl),
        row("LOG_LEVEL", logger.level),
        row("MIGRATE_ON_START", config.migrations.onStart ? "true" : "false"),
        secretRow("API_KEY_ENCRYPTION_KEY"),
        row("DATABASE_CA_CERT", config.database.caCert ? "verifying the server certificate" : "not set"),
    ];
    if (!edition.multiCluster) {
        // The one cluster's id is an identifier, not a credential; its key is
        // the credential and stays out.
        rows.push(row(BOOTSTRAP_CLUSTER_ID_VAR, process.env[BOOTSTRAP_CLUSTER_ID_VAR]?.trim() || "not set"));
    }

    return {
        build: {
            version: SERVER_VERSION,
            node: process.version,
            startedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
            uptimeSeconds,
        },
        edition: { value: edition.edition, source: isSet(EDITION_ENV_VAR) ? "set" : "default" },
        topology: { value: topology, source: isSet(TOPOLOGY_ENV_VAR) ? "set" : "default" },
        config: rows,
        mirror: {
            configuredEcosystems,
            liveEcosystems,
            matchesConfig: liveEcosystems === undefined ? false : sameScope(liveEcosystems, configuredEcosystems),
        },
        migrations: { server: serverChain, auth: authChain },
    };
}
