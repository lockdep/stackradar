import { Eye, EyeOff, KeyRound, Plug, ScanSearch, Terminal } from 'lucide-react';
import { Button, ErrorBlock, LoadingBlock } from '@/components/ui';
import { isAdminOrOwner, useOrganization, useRuntimeConfig } from '@/components/providers';
import { ConnectClusterInstructions } from '@/components/clusters/ConnectClusterInstructions';
import { useApiKeyReveal } from '@/components/clusters/useApiKeyReveal';
import { useResource } from '@/hooks';
import { WaitingForFirstData } from './WaitingForFirstData';

function ApiKeyGateSkeleton() {
    return (
        <div
            className="rounded-md border border-edge bg-surface-raised p-6 shadow-resting"
            aria-busy="true"
            aria-label="Checking API key"
        >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="shrink-0 size-10 rounded-md bg-surface-hover animate-pulse" />
                <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-4 w-48 rounded-sm bg-surface-hover animate-pulse" />
                    <div className="h-3 w-72 max-w-full rounded-sm bg-surface-hover animate-pulse" />
                    <div className="h-3 w-56 max-w-full rounded-sm bg-surface-hover animate-pulse" />
                </div>
                <div className="h-9 w-36 rounded-md bg-surface-hover animate-pulse shrink-0" />
            </div>
        </div>
    );
}

type ApiKeyInfo = {
    apiKey: string; // "prefix••••••••••••••••••"
    createdAt: string;
    lastUsedAt: string | null;
    /** Whether the server can show the plaintext again — false for keys minted before the vault. */
    revealable: boolean;
};

function useClusterApiKeyInfo(clusterId: string, refreshKey: number) {
    const { data, error, isLoading } = useResource<ApiKeyInfo>(`/api/clusters/${clusterId}/api-key`, { refreshKey });
    /* Soft-fail: a refusal or a failed read is "no key", never an error to show. */
    return { info: error ? null : data, checked: !isLoading };
}

export function ContainersLoading({ label = 'Loading cluster...' }: { label?: string } = {}) {
    return (
        <div>
            <LoadingBlock label={label} />
        </div>
    );
}

export function ContainersError({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <ErrorBlock
            title="Failed to load containers"
            message={error}
            icon={
                <svg
                    className="size-6 text-danger"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="1.5"
                    stroke="currentColor"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                    />
                </svg>
            }
            onRetry={onRetry}
        />
    );
}

export function ContainersEmpty({
    cluster,
    onConnect,
    refreshKey = 0,
    justInstalled = false,
}: {
    cluster: { id: string; name: string };
    onConnect: () => void;
    /** Bump to force a re-check of the API key (e.g. after the connect dialog closes). */
    refreshKey?: number;
    justInstalled?: boolean;
}) {
    const { info, checked } = useClusterApiKeyInfo(cluster.id, refreshKey);
    const hasKey = checked && info !== null;
    /* The community edition's scanner was installed with StackRadar and
       authenticates with the server's bootstrap key: there is no key to
       generate and no command to run, only a scanner to wait for. */
    const { edition } = useRuntimeConfig();
    const selfScanning = !edition.multiCluster;

    return (
        <div className="my-8">
            <div className="text-center py-10">
                {/* Two different waits, so two different marks. Straight after
                    the wizard the scanner is expected to report at any moment
                    and the radar says the page is listening for it; without
                    that, nothing is on its way and a live-looking animation
                    would be claiming otherwise. */}
                {justInstalled ? (
                    <>
                        <WaitingForFirstData />
                        <h3 className="mt-5 text-base font-semibold text-ink">
                            Waiting for the first containers from {cluster.name}
                        </h3>
                        <p className="mt-2 text-sm text-ink-muted max-w-sm mx-auto">
                            Expect the first findings within minutes of the scanner starting — they&apos;ll appear here
                            on their own, no refresh needed. If nothing shows up, check the scanner logs.
                        </p>
                    </>
                ) : (
                    <>
                        <div className="mx-auto size-14 rounded-md bg-surface-muted ring-1 ring-edge flex items-center justify-center">
                            <ScanSearch className="size-7 text-ink-faint" />
                        </div>
                        <h3 className="mt-4 text-base font-semibold text-ink">No containers yet</h3>
                        <p className="mt-2 text-sm text-ink-muted max-w-sm mx-auto">
                            {selfScanning ? (
                                <>
                                    The scanner installed with StackRadar reports{' '}
                                    <span className="font-medium text-ink-secondary">{cluster.name}</span>&apos;s
                                    running containers here as it finds them. If nothing arrives within a few minutes,
                                    check the scanner pod&apos;s logs.
                                </>
                            ) : (
                                <>
                                    Install the scanner in{' '}
                                    <span className="font-medium text-ink-secondary">{cluster.name}</span> and its
                                    running containers will appear here automatically as it finds them.
                                </>
                            )}
                        </p>
                    </>
                )}
            </div>

            {!justInstalled && !selfScanning && (
                <div className="max-w-3xl mx-auto my-2">
                    {!checked ? (
                        <ApiKeyGateSkeleton />
                    ) : !hasKey ? (
                        <ApiKeyGate onGenerate={onConnect} />
                    ) : (
                        <InstallInline
                            cluster={cluster}
                            waiting={info?.lastUsedAt === null}
                            revealable={info?.revealable === true}
                            onRotateKey={onConnect}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function ApiKeyGate({ onGenerate }: { onGenerate: () => void }) {
    return (
        <div className="rounded-md border border-edge bg-surface-raised p-6 shadow-resting">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="shrink-0 rounded-md bg-success-subtle p-2.5 ring-1 ring-success-muted">
                    <KeyRound className="size-5 text-success" />
                </div>
                <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-ink">Generate an API key to get started</h4>
                    <p className="mt-1 text-sm text-ink-muted">
                        Generate a unique API key and we&apos;ll give you a ready-to-run install command.
                    </p>
                </div>
                <Button variant="primary" onClick={onGenerate} className="shrink-0">
                    <Plug className="size-4" />
                    Generate API key
                </Button>
            </div>
        </div>
    );
}

/**
 * The install command, on the page rather than behind a "View install
 * command" button: a reader on an empty cluster page has exactly one thing
 * to do, and a click to find out what it is was a step between them and it.
 *
 * The command carries a `<your-api-key>` placeholder until an admin reveals
 * the key, which fills it in for a minute; the dialog behind `onRotateKey`
 * mints a fresh one for the reader whose key cannot be revealed.
 */
function InstallInline({
    cluster,
    waiting,
    revealable,
    onRotateKey,
}: {
    cluster: { id: string; name: string };
    /** The key has never authenticated — the scanner is not running yet. */
    waiting: boolean;
    /** The server can show the plaintext again (see `ScannerKeyPanel`). */
    revealable: boolean;
    onRotateKey: () => void;
}) {
    const { organization } = useOrganization();
    const { demoMode } = useRuntimeConfig();
    const canReveal = isAdminOrOwner(organization) && !demoMode && revealable;
    const revealed = useApiKeyReveal(cluster.id);

    return (
        <div className="rounded-md border border-edge bg-surface-raised shadow-resting">
            <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start">
                {waiting ? (
                    <div className="relative shrink-0 flex items-center justify-center size-10 rounded-md bg-surface-muted ring-1 ring-edge">
                        <span className="absolute size-5 rounded-full bg-success-subtle animate-ping" />
                        <span className="relative size-2.5 rounded-full bg-accent-emphasis" />
                    </div>
                ) : (
                    <div className="shrink-0 rounded-md bg-surface-muted p-2.5 ring-1 ring-edge">
                        <Terminal className="size-5 text-ink-faint" />
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-ink">
                        {waiting ? 'Waiting for scanner to connect' : 'Install the scanner'}
                    </h4>
                    <p className="mt-1 text-sm text-ink-muted">
                        {waiting
                            ? 'The cluster is registered — run the commands below in it and containers appear here automatically once the scanner starts uploading. This page keeps checking, so there’s no need to refresh.'
                            : 'Run the commands below in the cluster and its running containers appear here as the scanner finds them.'}
                    </p>
                </div>
            </div>
            <div className="border-t border-edge px-6 py-6">
                <ConnectClusterInstructions
                    clusterId={cluster.id}
                    clusterName={cluster.name}
                    apiKey={revealed.apiKey}
                />
            </div>
            <div className="flex flex-col gap-3 border-t border-edge bg-surface-muted px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                    <p className="text-sm text-ink-muted">
                        {revealed.apiKey
                            ? 'The key is filled into the commands above and hides again in a minute.'
                            : canReveal
                              ? 'Reveal the API key to fill it into the commands above. Every reveal is recorded.'
                              : 'The API key was shown once, when it was generated. Lost it? A new one replaces the old immediately.'}
                    </p>
                    {revealed.error && <p className="mt-1 text-sm text-danger">{revealed.error.message}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {canReveal &&
                        (revealed.apiKey ? (
                            <Button variant="secondary" onClick={revealed.hide}>
                                <EyeOff className="size-4" />
                                Hide key
                            </Button>
                        ) : (
                            <Button variant="primary" onClick={revealed.reveal} loading={revealed.isRevealing}>
                                {!revealed.isRevealing && <Eye className="size-4" />}
                                Reveal API key
                            </Button>
                        ))}
                    <Button variant="secondary" onClick={onRotateKey}>
                        Generate a new API key
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * Nothing survived the search *or* the filters.
 *
 * The copy names both, because the two are easy to confuse from the empty
 * result alone: a filter set in one session and carried in on a pasted URL
 * looks exactly like a cluster with nothing in it.
 */
export function ContainersNoResults({ onClearFilters }: { onClearFilters?: () => void }) {
    return (
        <div className="mt-8 text-center py-12">
            <p className="text-sm text-ink-muted">No containers match the current search and filters.</p>
            {onClearFilters && (
                <button
                    type="button"
                    onClick={onClearFilters}
                    className="mt-2 cursor-pointer text-sm text-accent underline underline-offset-2"
                >
                    Clear filters
                </button>
            )}
        </div>
    );
}
