import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createApiHeaders, getExpressUrl, getRequestId, handleApiError } from '@/lib/api-utils';
import { enabledProviders, oidcDisplayName, type OAuthProviderId } from '@/lib/auth-providers';
import { isLocalLoginEnabled } from '@/lib/local-login';
import { createLogger } from '@/lib/logger';

/**
 * `GET /api/admin/system` — the System tab's report
 * (`views/admin/SystemTab.tsx`).
 *
 * An explicit route rather than the catch-all because the report is two
 * apps' worth of facts and only this process knows the client's half: its
 * own version, which sign-in methods are on (`lib/auth-providers.ts`,
 * `lib/local-login.ts`), and whether the `auth` schema is current — the
 * server reads `auth.__drizzle_migrations` but has no journal to judge it
 * against, so the tag and the verdict are added here from this app's
 * `drizzle/meta/_journal.json`. Express's report passes through under
 * `server`; nothing in it is rewritten.
 *
 * Only names and booleans leave: provider ids and a label, never a client
 * id or secret. Same gate as the catch-all applies to `admin/*`.
 */

const log = createLogger('api.admin.system');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export interface SignInMethod {
    id: 'password' | OAuthProviderId;
    label: string;
}

export interface AuthMigrationChain {
    /** Rows in `auth.__drizzle_migrations`; null when the table does not exist. */
    applied: number | null;
    latestAppliedAt: string | null;
    latestTag: string | null;
    chainLength: number;
    chainLatestTag: string | null;
    current: boolean;
}

/** The server's report, as `services/admin-system.service.ts` shapes it. Typed here for the tab. */
export interface ServerSystemReport {
    build: { version: string; node: string; startedAt: string; uptimeSeconds: number };
    edition: { value: 'community' | 'cloud'; source: 'set' | 'default' };
    topology: { value: 'monolith' | 'split'; source: 'set' | 'default' };
    config: Array<{ key: string; value: string; source: 'set' | 'default' }>;
    mirror: {
        configuredEcosystems: string[] | null;
        liveEcosystems: string[] | null | undefined;
        matchesConfig: boolean;
    };
    migrations: {
        server: {
            applied: number | null;
            latestAppliedAt: string | null;
            latestTag: string | null;
            chainLength: number;
            chainLatestTag: string | null;
            current: boolean;
        };
        auth: { applied: number | null; latestAppliedAt: string | null };
    };
}

export interface AdminSystemData extends Omit<ServerSystemReport, 'migrations'> {
    client: {
        /** This app's `package.json` version, plus the short git sha when the image carries one. */
        version: string;
        node: string;
        signIn: SignInMethod[];
        /** `AUTH_OIDC_ADMIN_GROUP` is set: the admin flag is re-evaluated at every OIDC sign-in. */
        oidcAdminGroup: boolean;
    };
    migrations: {
        server: ServerSystemReport['migrations']['server'];
        auth: AuthMigrationChain;
    };
}

/** Same rule as the server's `lib/server-version.ts`: version, plus `+sha` when built with one. */
function clientVersion(): string {
    let version = '0.0.0';
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: unknown };
        if (typeof pkg.version === 'string' && pkg.version !== '') version = pkg.version;
    } catch {
        // A version string is not worth an error page.
    }
    const sha = process.env.GIT_SHA?.trim();
    return sha ? `${version}+${sha.slice(0, 7)}` : version;
}

interface JournalEntry {
    when: number;
    tag: string;
}

/**
 * This app's chain, from the same `drizzle/meta/_journal.json`
 * `scripts/migrate.mjs` applies — found the way that script finds it,
 * walking up from this module, which works from `src/app/api/…` in
 * development and from the standalone bundle in the image, where the
 * Dockerfile copies `drizzle/` beside `server.js`.
 */
function readAuthJournal(): JournalEntry[] {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
        const candidate = join(dir, 'drizzle', 'meta', '_journal.json');
        try {
            const journal = JSON.parse(readFileSync(candidate, 'utf-8')) as {
                entries?: Array<{ when?: unknown; tag?: unknown }>;
            };
            return (journal.entries ?? [])
                .filter((e): e is JournalEntry => typeof e.when === 'number' && typeof e.tag === 'string')
                .map((e) => ({ when: e.when, tag: e.tag }));
        } catch {
            const parent = resolve(dir, '..');
            if (parent === dir) break;
            dir = parent;
        }
    }
    log.warn('could not read the auth migration journal; the System tab cannot say whether the auth schema is current');
    return [];
}

function authChain(applied: ServerSystemReport['migrations']['auth']): AuthMigrationChain {
    const journal = readAuthJournal();
    const newest = journal[journal.length - 1] ?? null;
    const latestMs = applied.latestAppliedAt ? new Date(applied.latestAppliedAt).getTime() : null;
    return {
        ...applied,
        latestTag: latestMs == null ? null : (journal.find((e) => e.when === latestMs)?.tag ?? null),
        chainLength: journal.length,
        chainLatestTag: newest?.tag ?? null,
        current: newest !== null && latestMs !== null && latestMs >= newest.when,
    };
}

const PROVIDER_LABEL: Record<OAuthProviderId, string> = {
    github: 'GitHub',
    google: 'Google',
    oidc: 'OIDC',
};

function signInMethods(): SignInMethod[] {
    const methods: SignInMethod[] = [];
    if (isLocalLoginEnabled()) methods.push({ id: 'password', label: 'Username and password' });
    for (const id of enabledProviders()) {
        methods.push({
            id,
            label: id === 'oidc' ? `${PROVIDER_LABEL.oidc} (${oidcDisplayName()})` : PROVIDER_LABEL[id],
        });
    }
    return methods;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!session.user.isAdmin) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const reqId = getRequestId(request);
    try {
        const upstream = await fetch(`${getExpressUrl()}/api/admin/system`, {
            headers: { ...(await createApiHeaders(session, request)), 'X-Request-Id': reqId },
            cache: 'no-store',
        });
        if (!upstream.ok) {
            const body = (await upstream.json().catch(() => ({}))) as { error?: string };
            return NextResponse.json(
                { error: body.error ?? `The server answered ${upstream.status}` },
                { status: upstream.status, headers: NO_STORE },
            );
        }
        const server = (await upstream.json()) as ServerSystemReport;

        const data: AdminSystemData = {
            ...server,
            client: {
                version: clientVersion(),
                node: process.version,
                signIn: signInMethods(),
                oidcAdminGroup: Boolean(process.env.AUTH_OIDC_ADMIN_GROUP?.trim()),
            },
            migrations: { server: server.migrations.server, auth: authChain(server.migrations.auth) },
        };
        return NextResponse.json(data, { headers: NO_STORE });
    } catch (error) {
        return handleApiError(error, reqId);
    }
}
