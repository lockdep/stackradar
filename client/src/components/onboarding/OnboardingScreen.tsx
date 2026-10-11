'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, RefreshCw, Sparkles } from 'lucide-react';
import { Button, CodeBlock, Spinner } from '@/components/ui';
import { createClusterRequest, PlanLimitError } from '@/components/clusters/useClusters';
import { helmInstallCommand, scannerApiUrl, SCANNER_INSTALL_DOCS_URL } from '@/components/clusters/scannerInstall';
import { isAdminOrOwner, useOrganization, useRuntimeConfig } from '@/components/providers';
import type { Cluster } from '@/types/cluster';

/**
 * The name the first cluster gets without being asked for one. A cluster
 * name is a label for people, nothing keys on it, and the wizard's "what
 * should I call it?" was a question in front of the only thing that matters
 * here — the install. Renamed from the cluster's settings whenever it suits.
 */
export const DEFAULT_CLUSTER_NAME = 'My cluster';

type Setup =
    | { status: 'creating' }
    | { status: 'ready'; cluster: Cluster; apiKey: string }
    | { status: 'failed'; message: string; isPlanLimit: boolean };

interface OnboardingScreenProps {
    orgName: string;
    /** A cluster now exists for this org — the shell can stop gating. */
    onClusterReady: () => void;
    /** The user chose to explore without a cluster. */
    onSkip: () => void;
}

/**
 * The only thing a signed-in user sees until their org has a cluster (or they
 * skip): one Helm command.
 *
 * The cluster and its scanner key are created on mount rather than behind a
 * "Connect a cluster" button and a three-step wizard, because a new org has
 * exactly one sensible next action and nothing to decide before it. The
 * credentials go into the command as chart values, so the chart creates the
 * Secret itself and the install is a single paste; the two-step form (chart,
 * then `kubectl create secret`) stays in the cluster's own connection dialog.
 */
export function OnboardingScreen({ orgName, onClusterReady, onSkip }: OnboardingScreenProps) {
    const router = useRouter();
    const { organization } = useOrganization();
    const { scannerChartVersion, publicApiUrl, edition } = useRuntimeConfig();
    const apiUrl = scannerApiUrl(publicApiUrl, edition.isCloud);
    // Creating a cluster is admin/owner-only on the server; a member of a
    // cluster-less org gets pointed at their admin instead of a 403.
    const canConnect = isAdminOrOwner(organization);

    const [setup, setSetup] = useState<Setup>({ status: 'creating' });
    const [attempt, setAttempt] = useState(0);
    /* One request per attempt. Strict Mode mounts effects twice in
       development, and without this the org would get two clusters. */
    const ranAttempt = useRef(-1);

    useEffect(() => {
        if (!canConnect || ranAttempt.current === attempt) return;
        ranAttempt.current = attempt;
        (async () => {
            try {
                const { cluster, apiKey } = await createClusterRequest({ name: DEFAULT_CLUSTER_NAME });
                setSetup({ status: 'ready', cluster, apiKey });
            } catch (err) {
                setSetup({
                    status: 'failed',
                    message: err instanceof Error ? err.message : 'Failed to create cluster',
                    isPlanLimit: err instanceof PlanLimitError,
                });
            }
        })();
    }, [attempt, canConnect]);

    /* Back to the spinner here, not in the effect: the state that starts a
       request belongs to the click that asked for it. */
    const handleRetry = () => {
        setSetup({ status: 'creating' });
        setAttempt((n) => n + 1);
    };

    const handleInstalled = (cluster: Cluster) => {
        onClusterReady();
        router.push(`/clusters/${cluster.id}/containers?justInstalled=1`);
    };

    /* Org settings live behind the gate, so release it before navigating. */
    const handleUpgrade = () => {
        onSkip();
        router.push('/org-settings?tab=billing');
    };

    return (
        <div className="min-h-screen bg-surface flex flex-col">
            <header className="flex items-center justify-between px-6 py-4">
                <span className="text-sm font-semibold text-ink">StackRadar</span>
                <span className="text-sm text-ink-muted truncate max-w-[50%]">{orgName}</span>
            </header>

            <main className="flex flex-1 items-center justify-center px-4 pb-16">
                {/* Wide enough for the command's 80-character first line to
                    sit on one line at the code block's 13px mono, so the
                    thing to copy is never half hidden behind a scrollbar. */}
                <div className="w-full max-w-4xl">
                    <div className="rounded-md border border-edge bg-surface-raised shadow-resting px-8 py-8">
                        {!canConnect ? (
                            <>
                                <h1 className="text-2xl font-bold text-ink">Connect a cluster</h1>
                                <p className="mt-2 text-sm text-ink-muted">
                                    Ask an organization admin or owner to connect a cluster. StackRadar starts reporting
                                    as soon as the scanner is installed.
                                </p>
                            </>
                        ) : setup.status === 'creating' ? (
                            <div className="flex items-center gap-3 py-2">
                                <Spinner size="sm" className="text-ink-faint" />
                                <p className="text-sm text-ink-muted">Setting up your cluster…</p>
                            </div>
                        ) : setup.status === 'failed' ? (
                            <>
                                <h1 className="text-2xl font-bold text-ink">Couldn&apos;t set up your cluster</h1>
                                {setup.isPlanLimit ? (
                                    <div className="mt-4 rounded-md bg-attention-subtle border border-attention-muted p-4">
                                        <div className="flex items-start gap-3">
                                            <Sparkles className="size-4 text-attention mt-0.5 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-attention">
                                                    Cluster limit reached
                                                </p>
                                                <p className="text-xs text-attention mt-1">{setup.message}</p>
                                                <button
                                                    type="button"
                                                    onClick={handleUpgrade}
                                                    className="mt-2 text-xs font-semibold text-attention underline underline-offset-2 cursor-pointer"
                                                >
                                                    Upgrade plan →
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className="mt-4 rounded-md bg-danger-subtle border border-danger-muted p-3">
                                            <p className="text-sm text-danger">{setup.message}</p>
                                        </div>
                                        <div className="mt-4">
                                            <Button variant="primary" onClick={handleRetry}>
                                                <RefreshCw className="size-4" />
                                                Try again
                                            </Button>
                                        </div>
                                    </>
                                )}
                            </>
                        ) : (
                            <>
                                <h1 className="text-2xl font-bold text-ink">Install the scanner</h1>
                                <p className="mt-2 text-sm text-ink-muted">
                                    Run this in the cluster you want StackRadar to watch. Your cluster and its API key
                                    are already set up — the first containers show up within a few minutes.
                                </p>

                                <div className="mt-5">
                                    <CodeBlock
                                        code={helmInstallCommand({
                                            chartVersion: scannerChartVersion,
                                            apiUrl: apiUrl.url,
                                            credentials: { clusterId: setup.cluster.id, apiKey: setup.apiKey },
                                        })}
                                        variant="light"
                                        sensitive
                                        placeholders={!scannerChartVersion || apiUrl.placeholder}
                                    />
                                </div>
                                {apiUrl.placeholder && (
                                    <p className="mt-2 text-xs text-attention">
                                        Set <span className="font-mono">PUBLIC_API_URL</span> on the StackRadar web app
                                        to the API origin this cluster can reach, and the command will carry it; until
                                        then replace <span className="font-mono">{apiUrl.url}</span> by hand.
                                    </p>
                                )}

                                <p className="mt-3 text-xs text-ink-muted">
                                    The cluster is called{' '}
                                    <span className="font-medium text-ink-secondary">{setup.cluster.name}</span>; rename
                                    it any time from its settings. The API key is only shown here — if you leave before
                                    running the command, generate a new one from the same place.
                                </p>
                                <p className="mt-2 text-xs text-ink-muted">
                                    Prerequisites, private registries and what the scanner needs from the cluster are in
                                    the{' '}
                                    <a
                                        href={SCANNER_INSTALL_DOCS_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
                                    >
                                        install guide
                                        <ArrowUpRight className="size-3" aria-hidden="true" />
                                    </a>
                                    .
                                </p>

                                <div className="mt-6">
                                    <Button variant="primary" size="lg" onClick={() => handleInstalled(setup.cluster)}>
                                        I&apos;ve installed it
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="mt-6 text-center">
                        <button
                            type="button"
                            /* Once the cluster exists the gate has nothing left
                               to hold for, whatever the user does next. */
                            onClick={setup.status === 'ready' ? onClusterReady : onSkip}
                            className="text-sm text-ink-muted hover:text-ink-secondary hover:underline underline-offset-2 cursor-pointer"
                        >
                            Skip for now
                        </button>
                    </div>
                </div>
            </main>
        </div>
    );
}
