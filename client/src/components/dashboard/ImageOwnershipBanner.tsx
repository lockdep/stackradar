'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import { DialogTitle } from '@headlessui/react'
import { Hammer, X } from 'lucide-react'
import { Button, DetailDialog } from '@/components/ui'
import { ImageOwnershipList, useImageControl } from '@/components/image-control'
import { useRuntimeConfig } from '@/components/providers'
import {
    changesToSave,
    hasUnaskedRepositories,
    readDismissed,
    repositoryKey,
    storeDismissed,
} from '@/lib/image-control'

const subscribeToNothing = () => () => {}

/**
 * "Which of these do you build yourselves?" — the ten-second answer that
 * replaces the last of the guessing about who controls an image.
 *
 * A one-line set-up banner on the Dashboard; the list itself lives in a
 * dialog behind its button, so a new org with dozens of repositories does not
 * get a Dashboard that is all checklist. Shown while a repository is
 * unconfirmed and the reader has not dismissed it; detected ones come
 * pre-ticked with the reason beside them. Saving writes a rule only for what
 * the reader changed — plus one for each unconfirmed repository, because
 * leaving it unticked *is* the answer. The banner then has nothing left to
 * ask and does not return until a new repository appears. Owners and admins
 * only: members see nothing. In the live demo it renders with the demo org's
 * answers and no way to change them.
 */
export function ImageOwnershipBanner({ orgId, canManage }: { orgId: string; canManage: boolean }) {
    const { demoMode } = useRuntimeConfig()
    const visible = canManage || demoMode
    const { data, isSaving, saveError, save } = useImageControl(orgId, visible)
    const [ticked, setTicked] = useState<ReadonlyMap<string, boolean>>(new Map())
    const [dismissedNow, setDismissedNow] = useState(false)
    const [isOpen, setIsOpen] = useState(false)
    // Held from open until the fade-out ends: a save that leaves nothing to
    // ask would otherwise unmount the dialog mid-transition.
    const [dialogMounted, setDialogMounted] = useState(false)

    /* Storage through `useSyncExternalStore`, so server and first client
       render agree and no effect sets state. A string snapshot: a fresh Set
       per read would never compare equal. */
    const dismissedRaw = useSyncExternalStore(
        subscribeToNothing,
        () => [...readDismissed(orgId)].sort().join('\n'),
        () => ''
    )
    const dismissed = useMemo(() => new Set(dismissedRaw ? dismissedRaw.split('\n') : []), [dismissedRaw])

    if (!visible || !data || dismissedNow) return null
    const repositories = data.repositories
    const unconfirmed = repositories.filter(r => r.control === 'unknown')
    // The demo has no unconfirmed repositories by then; it shows the banner once per visit anyway.
    const showBanner =
        repositories.length > 0 && (demoMode || hasUnaskedRepositories(repositories, dismissed))
    if (!showBanner && !dialogMounted) return null

    const open = () => {
        setDialogMounted(true)
        setIsOpen(true)
    }

    const close = () => {
        if (isSaving) return
        setIsOpen(false)
        setTicked(new Map())
    }

    const dismiss = () => {
        storeDismissed(orgId, [...dismissed, ...unconfirmed.map(repositoryKey)])
        setDismissedNow(true)
    }

    const onSave = async () => {
        if (await save(changesToSave(repositories, ticked))) {
            setTicked(new Map())
            setIsOpen(false)
        }
    }

    const total = repositories.length
    const repoWord = total === 1 ? 'image repository' : 'image repositories'

    return (
        <>
            {showBanner && (
                <div
                    role="status"
                    className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border border-accent-muted bg-accent-subtle px-4 py-3"
                >
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <Hammer aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                        <div className="min-w-0 text-sm">
                            <p className="font-medium text-ink">Mark the images your team builds</p>
                            <p className="mt-0.5 text-xs text-ink-secondary">
                                StackRadar found {total.toLocaleString()} {repoWord} in your clusters. Telling it which
                                ones are yours lets it recommend the right fix: a dependency bump or base-image rebuild
                                for your images, an upstream upgrade for everything else.
                            </p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button variant="primary" size="sm" onClick={open}>
                            {demoMode ? 'View images' : 'Review images'}
                        </Button>
                        {!demoMode && (
                            <button
                                type="button"
                                onClick={dismiss}
                                aria-label="Dismiss"
                                className="cursor-pointer rounded-sm p-1 text-ink-muted hover:text-ink"
                            >
                                <X aria-hidden="true" className="size-4" />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {dialogMounted && (
                <DetailDialog isOpen={isOpen} onClose={close} afterLeave={() => setDialogMounted(false)}>
                    <div className="border-b border-edge px-6 pt-6 pb-4 pr-14">
                        <DialogTitle className="text-xl font-bold leading-tight text-ink">
                            Which images do you build yourselves?
                        </DialogTitle>
                        <p className="mt-2 text-sm text-ink-muted">
                            For images you build, StackRadar recommends dependency bumps and base-image rebuilds. For
                            third-party images it recommends one thing: the upstream upgrade. Tick the ones that are
                            yours; anything left unticked is treated as third-party.
                        </p>
                    </div>

                    <div className="min-h-0 overflow-y-auto px-6 py-4">
                        <ImageOwnershipList
                            repositories={repositories}
                            ticked={ticked}
                            readOnly={demoMode || isSaving}
                            onToggle={(key, built) => setTicked(prev => new Map(prev).set(key, built))}
                        />
                    </div>

                    <div className="flex flex-wrap items-center gap-3 border-t border-edge px-6 py-4">
                        <span className="min-w-0 flex-1 text-xs text-ink-muted">
                            {demoMode
                                ? 'Read-only in the demo.'
                                : 'You can change this later under Organization settings → Image ownership.'}
                        </span>
                        {saveError && <span className="text-xs text-danger">{saveError}</span>}
                        {demoMode ? (
                            <Button onClick={close}>Close</Button>
                        ) : (
                            <>
                                <Button onClick={close} disabled={isSaving}>
                                    Cancel
                                </Button>
                                <Button variant="primary" onClick={onSave} loading={isSaving}>
                                    Save
                                </Button>
                            </>
                        )}
                    </div>
                </DetailDialog>
            )}
        </>
    )
}
