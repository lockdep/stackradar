'use client';

import { CheckCircle, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useTabData } from './useTabData';
import { TabShell } from './Shared';
import { formatLag, formatTimeAgo } from './utils';
import type { AdminSystemData } from '@/app/api/admin/system/route';

/**
 * What this install is and how it is configured, read-only: the two apps'
 * versions, the edition and topology, every operator knob with its
 * effective value, which sign-in methods are on, and whether both schemas
 * are current. One screen for the question an operator otherwise answers
 * from a manifest, an env file and two journal tables.
 *
 * Three cards — Build, Configuration, Database — each a definition list.
 * Values sit in the right column; the prose is one line per card.
 */
export function SystemTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const { data, isLoading, error, refetch } = useTabData<AdminSystemData>(
        '/api/admin/system',
        refreshKey,
        onLoadingChange,
    );

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
                    <Card title="Build" subtitle="The two images, and the switches that decide what the product is.">
                        <Rows>
                            <Row label="Server" value={<Mono>{data.build.version}</Mono>} />
                            <Row label="Client" value={<Mono>{data.client.version}</Mono>} />
                            <Row label="Edition" value={data.edition.value} source={data.edition.source} />
                            <Row label="Topology" value={data.topology.value} source={data.topology.source} />
                            <Row label="Node (server)" value={<Mono>{data.build.node}</Mono>} />
                            <Row label="Node (client)" value={<Mono>{data.client.node}</Mono>} />
                            <Row
                                label="Server up"
                                value={`${formatLag(data.build.uptimeSeconds)} · since ${formatTimeAgo(data.build.startedAt)}`}
                            />
                        </Rows>
                    </Card>

                    <Card
                        title="Configuration"
                        subtitle="Each knob with the value in force. Set means the environment names it; default means the shipped value."
                    >
                        <Rows>
                            {data.config.map((row) => (
                                <Row
                                    key={row.key}
                                    label={<Mono>{row.key}</Mono>}
                                    value={row.value}
                                    source={row.source}
                                />
                            ))}
                        </Rows>
                        <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mt-5 mb-2">
                            Sign-in
                        </h3>
                        {data.client.signIn.length === 0 ? (
                            <p className="text-sm text-danger">No sign-in method is configured — nobody can sign in.</p>
                        ) : (
                            <ul className="space-y-1">
                                {data.client.signIn.map((m) => (
                                    <li key={m.id} className="text-sm text-ink-secondary flex items-center gap-2">
                                        <CheckCircle className="size-3.5 text-success" aria-hidden="true" />
                                        {m.label}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {data.client.oidcAdminGroup && (
                            <p className="text-xs text-ink-muted mt-2">
                                Platform admins follow an OIDC group: the flag is re-evaluated at every sign-in.
                            </p>
                        )}
                    </Card>

                    <Card
                        title="Database"
                        subtitle="One Postgres, two migration chains — the server's in `drizzle`, the client's in `auth` — and the mirror's scope."
                    >
                        <ChainRows
                            title="Server schema"
                            chain={data.migrations.server}
                            neverRan="The server has never migrated this database."
                        />
                        <ChainRows
                            title="Auth schema"
                            chain={data.migrations.auth}
                            neverRan="The client has never migrated this database — sign-in will fail until it does."
                        />
                        <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mt-5 mb-2">
                            OSV mirror scope
                        </h3>
                        <Rows>
                            <Row label="Configured" value={ecosystems(data.mirror.configuredEcosystems)} />
                            <Row
                                label="Mirror carries"
                                value={
                                    data.mirror.liveEcosystems === undefined
                                        ? 'nothing yet — no sync has run'
                                        : ecosystems(data.mirror.liveEcosystems)
                                }
                            />
                        </Rows>
                        {data.mirror.liveEcosystems !== undefined && !data.mirror.matchesConfig && (
                            <p className="text-xs text-attention mt-2 flex items-start gap-1.5">
                                <AlertCircle className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                                The mirror does not carry what is configured. Only a bootstrap can add an ecosystem; the
                                scheduler&apos;s next bootstrap check rebuilds it.
                            </p>
                        )}
                    </Card>
                </div>
            )}
        </TabShell>
    );
}

function ecosystems(list: string[] | null): string {
    return list === null ? 'everything OSV publishes' : list.join(', ');
}

interface Chain {
    applied: number | null;
    latestTag: string | null;
    chainLength: number;
    chainLatestTag: string | null;
    current: boolean;
}

function ChainRows({ title, chain, neverRan }: { title: string; chain: Chain; neverRan: string }) {
    return (
        <>
            <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mt-5 first:mt-0 mb-2">
                {title}
            </h3>
            {chain.applied === null ? (
                <p className="text-sm text-danger flex items-start gap-1.5">
                    <AlertCircle className="size-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    {neverRan}
                </p>
            ) : (
                <Rows>
                    <Row
                        label="Status"
                        value={
                            chain.current ? (
                                <Badge variant="success">current</Badge>
                            ) : (
                                <Badge variant="attention">behind this build</Badge>
                            )
                        }
                    />
                    <Row label="Applied" value={`${chain.applied} of ${chain.chainLength} in this build`} />
                    <Row label="Latest applied" value={<Mono>{chain.latestTag ?? 'not in this build'}</Mono>} />
                    {!chain.current && chain.chainLatestTag && (
                        <Row label="Newest in build" value={<Mono>{chain.chainLatestTag}</Mono>} />
                    )}
                </Rows>
            )}
        </>
    );
}

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
    return (
        <section className="bg-surface-raised rounded-md border border-edge p-5 min-w-0">
            <h2 className="text-sm font-semibold text-ink-secondary">{title}</h2>
            <p className="text-xs text-ink-muted mt-0.5 mb-4">{subtitle}</p>
            {children}
        </section>
    );
}

function Rows({ children }: { children: React.ReactNode }) {
    return <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-1.5 text-sm">{children}</dl>;
}

function Row({ label, value, source }: { label: React.ReactNode; value: React.ReactNode; source?: 'set' | 'default' }) {
    return (
        <>
            <dt className="text-ink-muted min-w-0 break-words">{label}</dt>
            <dd className="text-ink-secondary font-medium min-w-0 break-words flex flex-wrap items-center gap-1.5">
                {value}
                {source && (
                    <span className="text-[11px] font-normal text-ink-faint" title={sourceTitle(source)}>
                        {source}
                    </span>
                )}
            </dd>
        </>
    );
}

function sourceTitle(source: 'set' | 'default'): string {
    return source === 'set' ? 'Named in the environment' : 'The shipped default; the environment does not set it';
}

function Mono({ children }: { children: React.ReactNode }) {
    return <span className="font-mono text-xs">{children}</span>;
}
