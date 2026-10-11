'use client';

import { useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { useCluster } from './ClusterContext';
import { CLUSTER_NAME_HINT, CLUSTER_NAME_MAX_LENGTH, validateClusterName } from './newClusterWizard';

/** The "General" settings section: renames the cluster in place. */
export function ClusterIdentityForm() {
    const { cluster, setClusterName } = useCluster();

    const [renameValue, setRenameValue] = useState(cluster.name);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [renameSuccess, setRenameSuccess] = useState(false);

    const handleRename = async () => {
        const trimmed = renameValue.trim();
        if (trimmed === cluster.name) return;
        const validationError = validateClusterName(trimmed);
        if (validationError) {
            setRenameError(validationError);
            return;
        }
        setIsRenaming(true);
        setRenameError(null);
        setRenameSuccess(false);
        try {
            await apiFetch(`/api/clusters/${cluster.id}`, { method: 'PATCH', json: { name: trimmed } });
            setClusterName(trimmed);
            setRenameSuccess(true);
            setTimeout(() => setRenameSuccess(false), 3000);
        } catch (err) {
            setRenameError(errorMessage(err, 'Failed to rename cluster'));
        } finally {
            setIsRenaming(false);
        }
    };

    return (
        <section className="rounded-md border border-edge">
            <div className="px-5 py-4 border-b border-edge">
                <h3 className="text-base font-semibold text-ink">General</h3>
            </div>
            <div className="px-5 py-4 space-y-4">
                <div>
                    <label className="block text-sm font-medium text-ink mb-1.5">Cluster name</label>
                    <p className="text-xs text-ink-muted mb-2">{CLUSTER_NAME_HINT}</p>
                    <div className="flex items-center gap-3">
                        <input
                            type="text"
                            value={renameValue}
                            maxLength={CLUSTER_NAME_MAX_LENGTH}
                            onChange={(e) => {
                                setRenameValue(e.target.value);
                                setRenameError(null);
                                setRenameSuccess(false);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleRename();
                            }}
                            className="block w-full max-w-sm rounded-md border border-edge-strong px-3 py-2 text-sm text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none"
                        />
                        <button
                            type="button"
                            onClick={handleRename}
                            disabled={isRenaming || renameValue.trim() === cluster.name || !renameValue.trim()}
                            className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-surface shadow-resting hover:bg-ink/85 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
                        >
                            {isRenaming ? (
                                <svg
                                    className="animate-spin size-4"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                >
                                    <circle
                                        className="opacity-25"
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        strokeWidth="4"
                                    />
                                    <path
                                        className="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                    />
                                </svg>
                            ) : null}
                            {isRenaming ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                    {renameError && <p className="mt-2 text-sm text-danger">{renameError}</p>}
                    {renameSuccess && <p className="mt-2 text-sm text-success">Cluster renamed successfully.</p>}
                </div>
            </div>
        </section>
    );
}
