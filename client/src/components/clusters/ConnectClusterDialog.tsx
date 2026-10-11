'use client';

import { Fragment, useEffect, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { AlertTriangle, Check, ClipboardCopy, KeyRound, X } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import type { Cluster } from '@/types/cluster';
import { isAdminOrOwner, useOrganization } from '@/components/providers';
import { ConnectClusterInstructions } from './ConnectClusterInstructions';
import { revealClusterApiKey, RevealError } from './useApiKeyReveal';

interface ConnectClusterDialogProps {
    isOpen: boolean;
    onClose: () => void;
    cluster: Cluster | null;
    onRotateApiKey: (clusterId: string) => Promise<string>;
}

type View = 'instructions' | 'rotate-confirm';

/**
 * Shown from existing clusters that don't have a fresh plaintext API key to display.
 * - No key yet: confirms generate, then shows key + install command.
 * - Has existing key: shows install command (with placeholder); rotation is a secondary action.
 */
export function ConnectClusterDialog({ isOpen, onClose, cluster, onRotateApiKey }: ConnectClusterDialogProps) {
    const [apiKey, setApiKey] = useState<string | null>(null);
    /* A key just minted is shown once and must be saved; a key revealed from
       the vault can be shown again, and the warning has to say which. */
    const [keySource, setKeySource] = useState<'minted' | 'revealed'>('minted');
    const [isRotating, setIsRotating] = useState(false);
    const [isRevealing, setIsRevealing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [copiedId, setCopiedId] = useState(false);
    const [view, setView] = useState<View>('instructions');

    const { organization } = useOrganization();
    // Generating or rotating the scanner key is admin/owner-only on the
    // server. The dialog is also reachable by members (via the cluster
    // empty state), who get the instructions without the key actions.
    const canManageKey = isAdminOrOwner(organization);

    const isRotation = cluster?.hasApiKey === true;

    useEffect(() => {
        if (!isOpen) {
            setTimeout(() => {
                setApiKey(null);
                setKeySource('minted');
                setError(null);
                setIsRotating(false);
                setIsRevealing(false);
                setCopied(false);
                setView('instructions');
            }, 250);
        }
    }, [isOpen]);

    const handleRotate = async () => {
        if (!cluster) return;
        setIsRotating(true);
        setError(null);
        try {
            const key = await onRotateApiKey(cluster.id);
            setApiKey(key);
            setKeySource('minted');
            setView('instructions');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to generate API key');
        } finally {
            setIsRotating(false);
        }
    };

    const handleReveal = async () => {
        if (!cluster) return;
        setIsRevealing(true);
        setError(null);
        try {
            const key = await revealClusterApiKey(cluster.id);
            setApiKey(key);
            setKeySource('revealed');
        } catch (err) {
            setError(err instanceof RevealError || err instanceof Error ? err.message : 'Failed to reveal API key');
        } finally {
            setIsRevealing(false);
        }
    };

    const handleCopyKey = async () => {
        if (!apiKey) return;
        try {
            await navigator.clipboard.writeText(apiKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* noop */
        }
    };

    // Intentionally a no-op: prevents outside-click and ESC from dismissing the dialog,
    // which would risk losing a just-generated API key. Users must close via X or the footer.
    const noop = () => {};

    return (
        <Transition show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={noop}>
                <TransitionChild
                    as={Fragment}
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-backdrop" />
                </TransitionChild>

                <div className="fixed inset-0 z-10 overflow-y-auto">
                    <div className="flex min-h-full items-center justify-center p-4">
                        <TransitionChild
                            as={Fragment}
                            enter="ease-out duration-300"
                            enterFrom="opacity-0 scale-95"
                            enterTo="opacity-100 scale-100"
                            leave="ease-in duration-200"
                            leaveFrom="opacity-100 scale-100"
                            leaveTo="opacity-0 scale-95"
                        >
                            <DialogPanel className="relative w-full max-w-3xl transform overflow-hidden rounded-xl bg-surface-raised border border-edge shadow-floating transition-all">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    disabled={isRotating}
                                    className="absolute top-4 right-4 p-1.5 text-ink-faint hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer z-10"
                                    aria-label="Close"
                                >
                                    <X className="size-5" />
                                </button>

                                <div className="px-6 pt-6 pb-4 border-b border-edge">
                                    <div className="flex items-start gap-4 pr-10">
                                        <div className="flex-1 min-w-0">
                                            <DialogTitle className="text-lg font-semibold text-ink">
                                                {`Connect ${cluster?.name ?? 'cluster'}`}
                                            </DialogTitle>
                                            {cluster && (
                                                <button
                                                    type="button"
                                                    onClick={async () => {
                                                        await navigator.clipboard.writeText(cluster.id);
                                                        setCopiedId(true);
                                                        setTimeout(() => setCopiedId(false), 2000);
                                                    }}
                                                    className="mt-0.5 flex items-center gap-1 text-xs font-mono text-ink-muted hover:text-ink-secondary transition-colors group cursor-pointer"
                                                    title="Copy cluster ID"
                                                >
                                                    <span>{cluster.id}</span>
                                                    {copiedId ? (
                                                        <Check className="size-3 text-success" />
                                                    ) : (
                                                        <ClipboardCopy className="size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="px-6 py-6 max-h-[65vh] overflow-y-auto space-y-5">
                                    {/* No key yet: info panel before generating */}
                                    {!apiKey && !isRotation && cluster && (
                                        <div className="space-y-4">
                                            <div className="rounded-md bg-success-subtle border border-success-muted p-4">
                                                <div className="flex items-start gap-3">
                                                    <KeyRound className="mt-0.5 size-5 text-success shrink-0" />
                                                    <div className="text-sm text-success space-y-2">
                                                        <p>
                                                            This cluster doesn&apos;t have an API key yet. Generate one
                                                            now so the scanner running in your cluster can upload SBOMs.
                                                        </p>
                                                        <p className="text-xs text-success/80">
                                                            The key is cluster-scoped and shown only once — copy it
                                                            before closing this dialog.
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                            {error && (
                                                <div className="bg-danger-subtle border border-danger-muted rounded-md p-3">
                                                    <p className="text-sm text-danger">{error}</p>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Has existing key: show instructions or rotation confirmation */}
                                    {!apiKey &&
                                        isRotation &&
                                        cluster &&
                                        (view === 'rotate-confirm' ? (
                                            <div className="space-y-4">
                                                <div className="rounded-md bg-attention-subtle border border-attention-muted p-4">
                                                    <div className="flex items-start gap-3">
                                                        <AlertTriangle className="mt-0.5 size-5 text-attention shrink-0" />
                                                        <div className="text-sm text-attention space-y-2">
                                                            <p className="font-semibold">
                                                                Rotating will immediately revoke the existing key.
                                                            </p>
                                                            <p>
                                                                Any scanner pod using the current key will stop
                                                                authenticating until you update the secret with the new
                                                                key.
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                                {error && (
                                                    <div className="bg-danger-subtle border border-danger-muted rounded-md p-3">
                                                        <p className="text-sm text-danger">{error}</p>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <>
                                                <ConnectClusterInstructions
                                                    clusterId={cluster.id}
                                                    clusterName={cluster.name}
                                                    apiKey={null}
                                                    variant="light"
                                                />
                                                {error && (
                                                    <div className="bg-danger-subtle border border-danger-muted rounded-md p-3">
                                                        <p className="text-sm text-danger">{error}</p>
                                                    </div>
                                                )}
                                            </>
                                        ))}

                                    {/* Key was just generated: display key + full instructions */}
                                    {apiKey && cluster && (
                                        <>
                                            <div>
                                                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-secondary mb-2">
                                                    API key
                                                </label>
                                                <div className="flex items-center gap-2">
                                                    {/* ph-no-capture: keep the one-time key out of PostHog session replay */}
                                                    <div className="ph-no-capture flex-1 bg-surface-muted rounded-md ring-1 ring-edge px-4 py-3 font-mono text-sm text-ink overflow-hidden">
                                                        <span className="break-all">{apiKey}</span>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={handleCopyKey}
                                                        className="p-2.5 text-ink-muted hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors cursor-pointer"
                                                        title="Copy key"
                                                    >
                                                        {copied ? (
                                                            <Check className="size-5 text-success" />
                                                        ) : (
                                                            <ClipboardCopy className="size-5" />
                                                        )}
                                                    </button>
                                                </div>
                                                <div className="mt-3 rounded-md bg-attention-subtle border border-attention-muted p-3">
                                                    <p className="text-xs text-attention">
                                                        {keySource === 'minted' ? (
                                                            <>
                                                                <strong>Save this key now.</strong> This is the only
                                                                time you&apos;ll see it here.{' '}
                                                            </>
                                                        ) : (
                                                            <>
                                                                <strong>This reveal has been recorded.</strong>{' '}
                                                            </>
                                                        )}
                                                        Anyone with it can upload SBOMs to this cluster.
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="border-t border-edge" />
                                            <ConnectClusterInstructions
                                                clusterId={cluster.id}
                                                clusterName={cluster.name}
                                                apiKey={apiKey}
                                                variant="light"
                                            />
                                        </>
                                    )}
                                </div>

                                <div className="px-6 py-4 border-t border-edge bg-surface-muted flex gap-3 justify-end items-center">
                                    {apiKey ? (
                                        <Button variant="primary" size="lg" onClick={onClose}>
                                            Done
                                        </Button>
                                    ) : isRotation ? (
                                        view === 'rotate-confirm' ? (
                                            <>
                                                <Button
                                                    variant="secondary"
                                                    size="lg"
                                                    onClick={() => {
                                                        setView('instructions');
                                                        setError(null);
                                                    }}
                                                    disabled={isRotating}
                                                >
                                                    Cancel
                                                </Button>
                                                <button
                                                    type="button"
                                                    onClick={handleRotate}
                                                    disabled={isRotating}
                                                    className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-attention-emphasis hover:bg-attention-emphasis text-on-emphasis font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                                                >
                                                    {isRotating ? (
                                                        <>
                                                            <Spinner size="sm" />
                                                            Rotating…
                                                        </>
                                                    ) : (
                                                        'Confirm rotation'
                                                    )}
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                {canManageKey && (
                                                    <>
                                                        <Button
                                                            variant="invisible"
                                                            size="lg"
                                                            onClick={() => setView('rotate-confirm')}
                                                            disabled={isRevealing}
                                                        >
                                                            Rotate API key
                                                        </Button>
                                                        {/* Fills the key into the commands; a key minted
                                                            before the vault answers with a 409 that says
                                                            to rotate, shown under the instructions. */}
                                                        <Button
                                                            variant="secondary"
                                                            size="lg"
                                                            onClick={handleReveal}
                                                            loading={isRevealing}
                                                        >
                                                            {isRevealing ? 'Revealing…' : 'Reveal current key'}
                                                        </Button>
                                                    </>
                                                )}
                                                <Button variant="primary" size="lg" onClick={onClose}>
                                                    Close
                                                </Button>
                                            </>
                                        )
                                    ) : canManageKey ? (
                                        <>
                                            <Button size="lg" onClick={onClose} disabled={isRotating}>
                                                Cancel
                                            </Button>
                                            <Button
                                                variant="primary"
                                                size="lg"
                                                onClick={handleRotate}
                                                disabled={!cluster}
                                                loading={isRotating}
                                            >
                                                {isRotating ? 'Generating…' : 'Generate API key'}
                                            </Button>
                                        </>
                                    ) : (
                                        <Button variant="primary" size="lg" onClick={onClose}>
                                            Close
                                        </Button>
                                    )}
                                </div>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
