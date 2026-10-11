'use client';

import { useState } from 'react';
import { Button, LoadingBlock } from '@/components/ui';
import { ImageOwnershipList, useImageControl } from '@/components/image-control';
import { changesToSave, type RepositoryControl } from '@/lib/image-control';

/**
 * Image ownership — which image repositories the organization builds itself.
 *
 * The Dashboard asks once; this is where the answer is changed later. Same
 * list, plus what was detected for each repository and a reset to it. It
 * decides what is recommended: for an image you build, dependency bumps and a
 * base-image rebuild; for a third-party image, the upstream upgrade.
 */
export function ImageOwnershipTab({
    orgId,
    canManage,
    readOnly = false,
}: {
    orgId: string;
    canManage: boolean;
    readOnly?: boolean;
}) {
    const { data, error, isSaving, saveError, save } = useImageControl(orgId, canManage || readOnly);
    const [ticked, setTicked] = useState<ReadonlyMap<string, boolean>>(new Map());

    if (!canManage && !readOnly) {
        return (
            <p className="text-sm text-ink-muted">
                Only owners and admins can change which images the organization builds.
            </p>
        );
    }
    if (error && !data) return <p className="text-sm text-ink-muted">{error}</p>;
    if (!data) return <LoadingBlock label="Loading image repositories..." className="py-12" />;

    const { repositories } = data;
    const pending = changesToSave(repositories, ticked);

    const onSave = async () => {
        if (await save(pending)) setTicked(new Map());
    };
    const onReset = async (repo: RepositoryControl) => {
        await save([{ registry: repo.registry, repository: repo.repository, control: null }]);
        setTicked((prev) => {
            const next = new Map(prev);
            next.delete(`${repo.registry}/${repo.repository}`);
            return next;
        });
    };

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-base font-semibold text-ink">Image ownership</h2>
                <p className="mt-1 text-sm text-ink-muted">
                    Tick the image repositories your organization builds. Everything else is treated as third-party: its
                    one recommended action is the upstream upgrade.
                </p>
            </div>

            {repositories.length === 0 ? (
                <p className="rounded-md border border-edge bg-surface-raised px-4 py-3 text-sm text-ink-muted">
                    No running images yet. Repositories appear here once a cluster reports its containers.
                </p>
            ) : (
                <ImageOwnershipList
                    repositories={repositories}
                    ticked={ticked}
                    readOnly={readOnly || isSaving}
                    showDetected
                    onToggle={(key, built) => setTicked((prev) => new Map(prev).set(key, built))}
                    onReset={onReset}
                />
            )}

            {!readOnly && repositories.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" onClick={onSave} loading={isSaving} disabled={pending.length === 0}>
                        Save
                    </Button>
                    {pending.length > 0 && (
                        <span className="text-xs text-ink-muted">
                            {pending.length} {pending.length === 1 ? 'change' : 'changes'} to save
                        </span>
                    )}
                    {saveError && <span className="text-xs text-danger">{saveError}</span>}
                </div>
            )}
        </div>
    );
}
