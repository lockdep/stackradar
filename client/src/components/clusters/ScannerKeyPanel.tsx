'use client';

import { useState } from 'react';
import { Check, ClipboardCopy, Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';
import { isAdminOrOwner, useOrganization, useRuntimeConfig } from '@/components/providers';
import { useResource } from '@/hooks';
import { errorMessage } from '@/lib/api-client';
import { formatTimeAgo } from '@/utils/formatters';
import { useCluster } from './ClusterContext';
import { ConnectClusterDialog } from './ConnectClusterDialog';
import { rotateClusterApiKey } from './rotateClusterApiKey';
import { useApiKeyReveal } from './useApiKeyReveal';

type ApiKeyInfo = {
    apiKey: string;
    createdAt: string;
    lastUsedAt: string | null;
    /** Whether the server can show the plaintext again — false for keys minted before the vault. */
    revealable: boolean;
    lastRevealedAt: string | null;
};

/**
 * The "Scanner connection" and "API key" settings sections: connection
 * instructions (via `ConnectClusterDialog`), the masked key with its age,
 * and inline rotation with a one-time reveal of the new key.
 *
 * In the community edition (`edition.multiCluster` false) the scanner was
 * installed with StackRadar and its key comes from the server's
 * `BOOTSTRAP_CLUSTER_API_KEY`: the connection instructions and the rotate
 * control are not drawn, and the key section says where the key is set.
 * The masked key and its reveal stay — that is how an admin checks the
 * two sides agree.
 */
export function ScannerKeyPanel() {
    const { cluster } = useCluster();
    const { organization } = useOrganization();
    const { demoMode, edition } = useRuntimeConfig();
    // Reveal is admin/owner-only on the server (and refused outright for the
    // demo org); no button that would only 403.
    const canReveal = isAdminOrOwner(organization) && !demoMode;
    const revealed = useApiKeyReveal(cluster.id);

    const [connectDialogOpen, setConnectDialogOpen] = useState(false);

    const [showRotateKeyConfirm, setShowRotateKeyConfirm] = useState(false);
    const [isRotatingKey, setIsRotatingKey] = useState(false);
    const [rotateKeyError, setRotateKeyError] = useState<string | null>(null);
    const [newApiKey, setNewApiKey] = useState<string | null>(null);
    const [copiedNewKey, setCopiedNewKey] = useState(false);

    /* A failed read leaves the section without the masked key, as before:
       the error is not shown, the rotate control still is. */
    const {
        data: apiKeyInfo,
        isLoading: apiKeyInfoLoading,
        refetch: fetchApiKeyInfo,
    } = useResource<ApiKeyInfo>(cluster.hasApiKey ? `/api/clusters/${cluster.id}/api-key` : null);

    const handleRotateKeyInline = async () => {
        setIsRotatingKey(true);
        setRotateKeyError(null);
        try {
            const key = await rotateClusterApiKey(cluster.id);
            setNewApiKey(key);
            setShowRotateKeyConfirm(false);
            revealed.hide();
            void fetchApiKeyInfo();
        } catch (err) {
            setRotateKeyError(errorMessage(err, 'Failed to rotate API key'));
        } finally {
            setIsRotatingKey(false);
        }
    };

    const handleCopyNewKey = async () => {
        if (!newApiKey) return;
        try {
            await navigator.clipboard.writeText(newApiKey);
            setCopiedNewKey(true);
            setTimeout(() => setCopiedNewKey(false), 2000);
        } catch {
            /* noop */
        }
    };

    const [copiedRevealed, setCopiedRevealed] = useState(false);
    const handleCopyRevealed = async () => {
        if (!revealed.apiKey) return;
        try {
            await navigator.clipboard.writeText(revealed.apiKey);
            setCopiedRevealed(true);
            setTimeout(() => setCopiedRevealed(false), 2000);
        } catch {
            /* noop */
        }
    };

    return (
        <>
            {edition.multiCluster && (
                <section className="rounded-md border border-edge">
                    <div className="px-5 py-4 border-b border-edge">
                        <h3 className="text-base font-semibold text-ink">Scanner connection</h3>
                    </div>
                    <div className="px-5 py-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-ink">Connect a scanner</p>
                                <p className="text-sm text-ink-muted">
                                    View connection instructions and manage the scanner API key.
                                </p>
                            </div>
                            <Button variant="secondary" onClick={() => setConnectDialogOpen(true)} className="ml-4">
                                Manage connection
                            </Button>
                        </div>
                    </div>
                </section>
            )}

            {cluster.hasApiKey && (
                <section className="rounded-md border border-edge">
                    <div className="px-5 py-4 border-b border-edge">
                        <h3 className="text-base font-semibold text-ink">API key</h3>
                    </div>
                    <div className="px-5 py-4">
                        {newApiKey ? (
                            <div className="space-y-3">
                                <div>
                                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-secondary mb-2">
                                        New API key
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1 bg-surface-muted rounded-md ring-1 ring-edge px-4 py-3 font-mono text-sm text-ink overflow-hidden">
                                            <span className="break-all">{newApiKey}</span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleCopyNewKey}
                                            className="p-2.5 text-ink-muted hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors cursor-pointer"
                                            title="Copy key"
                                        >
                                            {copiedNewKey ? (
                                                <Check className="size-5 text-success" />
                                            ) : (
                                                <ClipboardCopy className="size-5" />
                                            )}
                                        </button>
                                    </div>
                                    <div className="mt-2 rounded-md bg-attention-subtle border border-attention-muted p-3">
                                        <p className="text-xs text-attention">
                                            <strong>Save this key now.</strong> This is the only time you&apos;ll see
                                            it. Anyone with it can upload SBOMs to this cluster.
                                        </p>
                                    </div>
                                </div>
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={() => setNewApiKey(null)}
                                        className="rounded-md px-3 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-hover cursor-pointer transition-colors"
                                    >
                                        Done
                                    </button>
                                </div>
                            </div>
                        ) : showRotateKeyConfirm ? (
                            <div className="space-y-3">
                                <div className="rounded-md bg-attention-subtle border border-attention-muted p-4">
                                    <div className="flex items-start gap-3">
                                        <TriangleAlert className="size-5 text-attention shrink-0 mt-0.5" />
                                        <div className="text-sm text-attention space-y-1">
                                            <p className="font-semibold">
                                                Rotating will immediately revoke the existing key.
                                            </p>
                                            <p>
                                                Any scanner using the current key will stop authenticating until you
                                                update the secret with the new key.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                                {rotateKeyError && <p className="text-sm text-danger">{rotateKeyError}</p>}
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={handleRotateKeyInline}
                                        disabled={isRotatingKey}
                                        className="inline-flex items-center gap-1.5 rounded-md bg-attention-emphasis px-3 py-2 text-sm font-semibold text-on-emphasis shadow-resting hover:bg-attention-emphasis disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    >
                                        {isRotatingKey ? (
                                            <>
                                                <Spinner size="sm" />
                                                Rotating…
                                            </>
                                        ) : (
                                            'Confirm rotation'
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowRotateKeyConfirm(false);
                                            setRotateKeyError(null);
                                        }}
                                        disabled={isRotatingKey}
                                        className="rounded-md px-3 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-hover disabled:opacity-40 cursor-pointer transition-colors"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {apiKeyInfoLoading && !apiKeyInfo ? (
                                    <div className="h-10 rounded-md bg-surface-hover animate-pulse" />
                                ) : apiKeyInfo ? (
                                    <div>
                                        <div className="flex items-start gap-2">
                                            {/* ph-no-capture: a revealed key stays out of session replay */}
                                            <div className="ph-no-capture min-w-0 flex-1 rounded-md bg-surface-muted ring-1 ring-edge px-4 py-3">
                                                <p className="font-mono text-sm text-ink break-all">
                                                    {revealed.apiKey ?? apiKeyInfo.apiKey}
                                                </p>
                                                <p className="mt-1 text-xs text-ink-muted">
                                                    Generated {formatTimeAgo(new Date(apiKeyInfo.createdAt))}
                                                    {apiKeyInfo.lastRevealedAt && (
                                                        <>
                                                            {' '}
                                                            · last revealed{' '}
                                                            {formatTimeAgo(new Date(apiKeyInfo.lastRevealedAt))}
                                                        </>
                                                    )}
                                                </p>
                                            </div>
                                            {revealed.apiKey && (
                                                <button
                                                    type="button"
                                                    onClick={handleCopyRevealed}
                                                    className="p-2.5 text-ink-muted hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors cursor-pointer"
                                                    title="Copy key"
                                                >
                                                    {copiedRevealed ? (
                                                        <Check className="size-5 text-success" />
                                                    ) : (
                                                        <ClipboardCopy className="size-5" />
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                        {/* The reveal is the server's decision to make: the
                                            control shows only when it would succeed, and the
                                            key hides itself again after a minute. */}
                                        {canReveal && apiKeyInfo.revealable && (
                                            <div className="mt-2 flex flex-wrap items-center gap-3">
                                                {revealed.apiKey ? (
                                                    <>
                                                        <Button variant="secondary" size="sm" onClick={revealed.hide}>
                                                            <EyeOff className="size-3.5" />
                                                            Hide key
                                                        </Button>
                                                        <p className="text-xs text-ink-muted">
                                                            Hides by itself in a minute.
                                                        </p>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={revealed.reveal}
                                                            loading={revealed.isRevealing}
                                                        >
                                                            {!revealed.isRevealing && <Eye className="size-3.5" />}
                                                            Reveal key
                                                        </Button>
                                                        <p className="text-xs text-ink-muted">
                                                            Every reveal is recorded.
                                                        </p>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                        {canReveal && !apiKeyInfo.revealable && (
                                            <p className="mt-2 text-xs text-ink-muted">
                                                This key was created before keys could be shown again. Rotate it to get
                                                one that can.
                                            </p>
                                        )}
                                        {revealed.error && (
                                            <p className="mt-2 text-sm text-danger">{revealed.error.message}</p>
                                        )}
                                    </div>
                                ) : null}
                                {edition.multiCluster ? (
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-sm font-medium text-ink">Rotate API key</p>
                                            <p className="text-sm text-ink-muted">
                                                Generate a new key and immediately revoke the existing one.
                                            </p>
                                        </div>
                                        <Button
                                            variant="secondary"
                                            onClick={() => setShowRotateKeyConfirm(true)}
                                            className="ml-4"
                                        >
                                            Rotate key
                                        </Button>
                                    </div>
                                ) : (
                                    <p className="text-sm text-ink-muted">
                                        This key is set by{' '}
                                        <code className="font-mono text-xs">BOOTSTRAP_CLUSTER_API_KEY</code> on the
                                        server and rendered into the scanner&apos;s secret by the chart. To rotate it,
                                        change the value there and restart the server.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </section>
            )}

            {edition.multiCluster && (
                <ConnectClusterDialog
                    isOpen={connectDialogOpen}
                    onClose={() => setConnectDialogOpen(false)}
                    cluster={cluster}
                    onRotateApiKey={rotateClusterApiKey}
                />
            )}
        </>
    );
}
