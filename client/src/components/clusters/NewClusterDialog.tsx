'use client'

import { Fragment, useReducer } from 'react'
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { Cluster } from '@/types/cluster'
import { NewClusterApiKeyStep } from './NewClusterApiKeyStep'
import { NewClusterDetailsStep } from './NewClusterDetailsStep'
import { NewClusterInstallStep } from './NewClusterInstallStep'
import {
    initialWizardState,
    validateClusterName,
    WIZARD_STEPS,
    wizardReducer,
} from './newClusterWizard'
import { PlanLimitError, type CreatedCluster } from './useClusters'

interface NewClusterDialogProps {
    isOpen: boolean
    onClose: () => void
    /** Creates the cluster and returns it with its scanner key, minted server-side in the same request. */
    onCreate: (input: { name: string; description?: string }) => Promise<CreatedCluster>
    onCreated?: (cluster: Cluster) => void
    onInstalled?: (cluster: Cluster) => void
    onUpgrade?: () => void
}

export function NewClusterDialog({ isOpen, onClose, onCreate, onCreated, onInstalled, onUpgrade }: NewClusterDialogProps) {
    const [state, dispatch] = useReducer(wizardReducer, initialWizardState)

    const isBusy = state.step === 'details' && state.isCreating

    const nameError = state.step === 'details' ? validateClusterName(state.name) : null

    const handleClose = () => {
        if (isBusy) return
        if (state.step !== 'details') onCreated?.(state.cluster)
        onClose()
        setTimeout(() => dispatch({ type: 'RESET' }), 250)
    }

    const handleCreateCluster = async (e: React.FormEvent) => {
        e.preventDefault()
        dispatch({ type: 'NAME_TOUCHED' })

        if (state.step !== 'details' || nameError) return

        dispatch({ type: 'CREATE_START' })

        try {
            const { cluster, apiKey } = await onCreate({
                name: state.name.trim(),
                ...(state.description.trim() ? { description: state.description.trim() } : {}),
            })
            dispatch({ type: 'CREATE_SUCCESS', cluster, apiKey })
        } catch (err) {
            if (err instanceof PlanLimitError) {
                dispatch({ type: 'CREATE_FAILURE', message: err.message, isPlanLimit: true })
            } else {
                dispatch({
                    type: 'CREATE_FAILURE',
                    message: err instanceof Error ? err.message : 'Failed to create cluster',
                    isPlanLimit: false,
                })
            }
        }
    }

    const handleCopyKey = async () => {
        if (state.step !== 'apiKey') return
        try {
            await navigator.clipboard.writeText(state.apiKey)
            dispatch({ type: 'KEY_COPIED' })
            setTimeout(() => dispatch({ type: 'COPY_INDICATOR_EXPIRED' }), 2000)
        } catch {
            /* noop */
        }
    }

    const handleDone = () => {
        if (state.step === 'install') onInstalled?.(state.cluster)
        onClose()
        setTimeout(() => dispatch({ type: 'RESET' }), 250)
    }

    const currentStepIndex = WIZARD_STEPS.findIndex(s => s.id === state.step)

    // Intentionally a no-op: prevents outside-click and ESC from dismissing the wizard,
    // which would risk losing a just-generated API key. Users must close via X or the footer.
    const noop = () => {}

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
                                    onClick={handleClose}
                                    disabled={isBusy}
                                    className="absolute top-4 right-4 p-1.5 text-ink-faint hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer z-10"
                                    aria-label="Close"
                                >
                                    <X className="size-5" />
                                </button>

                                {/* Header with stepper */}
                                <div className="px-6 pt-6 pb-4 border-b border-edge">
                                    <div className="flex items-start gap-4 pr-10">
                                        <div className="flex-1 min-w-0">
                                            <DialogTitle className="text-lg font-semibold text-ink">
                                                {state.step === 'details' && 'Connect a cluster'}
                                                {state.step === 'apiKey' && 'Save your cluster API key'}
                                                {state.step === 'install' && 'Install the scanner'}
                                            </DialogTitle>
                                            <p className="mt-1 text-sm text-ink-muted">
                                                {state.step === 'details' && 'Register a Kubernetes cluster to track its running containers.'}
                                                {state.step === 'apiKey' && 'This key is only shown once. Copy it now — you won\'t see it again.'}
                                                {state.step === 'install' && 'Point the scanner at your cluster with the command below.'}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Stepper */}
                                    <div className="mt-5 flex items-center gap-2">
                                        {WIZARD_STEPS.map((s, idx) => {
                                            const isCurrent = s.id === state.step
                                            const isDone = idx < currentStepIndex
                                            return (
                                                <Fragment key={s.id}>
                                                    <div className="flex items-center gap-2">
                                                        <div
                                                            className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                                                                isDone
                                                                    ? 'bg-accent-emphasis text-on-emphasis'
                                                                    : isCurrent
                                                                        ? 'bg-ink text-surface'
                                                                        : 'bg-surface-hover text-ink-muted ring-1 ring-edge'
                                                            }`}
                                                        >
                                                            {isDone ? <Check className="size-3.5" /> : idx + 1}
                                                        </div>
                                                        <span
                                                            className={`text-xs font-medium ${
                                                                isCurrent ? 'text-ink' : isDone ? 'text-ink-secondary' : 'text-ink-muted'
                                                            }`}
                                                        >
                                                            {s.label}
                                                        </span>
                                                    </div>
                                                    {idx < WIZARD_STEPS.length - 1 && (
                                                        <div
                                                            className={`h-px flex-1 ${isDone ? 'bg-accent-emphasis' : 'bg-track'}`}
                                                        />
                                                    )}
                                                </Fragment>
                                            )
                                        })}
                                    </div>
                                </div>

                                {/* Body */}
                                <div className="px-6 py-6 max-h-[60vh] overflow-y-auto">
                                    {state.step === 'details' && (
                                        <NewClusterDetailsStep
                                            state={state}
                                            nameError={nameError}
                                            dispatch={dispatch}
                                            onSubmit={handleCreateCluster}
                                            onUpgrade={onUpgrade ? () => { handleClose(); onUpgrade() } : undefined}
                                        />
                                    )}

                                    {state.step === 'apiKey' && (
                                        <NewClusterApiKeyStep
                                            cluster={state.cluster}
                                            apiKey={state.apiKey}
                                            copied={state.copied}
                                            onCopy={handleCopyKey}
                                        />
                                    )}

                                    {state.step === 'install' && (
                                        <NewClusterInstallStep cluster={state.cluster} apiKey={state.apiKey} />
                                    )}
                                </div>

                                {/* Footer */}
                                <div className="px-6 py-4 border-t border-edge bg-surface-muted flex gap-3 justify-end">
                                    {state.step === 'details' && (
                                        <>
                                            <Button
                                                onClick={handleClose}
                                                disabled={state.isCreating}
                                                size="lg"
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                type="submit"
                                                variant="primary"
                                                size="lg"
                                                form="new-cluster-form"
                                                disabled={!!nameError}
                                                loading={state.isCreating}
                                            >
                                                {state.isCreating ? 'Creating…' : 'Create cluster'}
                                            </Button>
                                        </>
                                    )}
                                    {state.step === 'apiKey' && (
                                        state.showCopyConfirm ? (
                                            <div className="flex items-center gap-3 w-full">
                                                <p className="flex-1 text-sm text-ink-secondary">Have you saved your API key?</p>
                                                <Button size="lg" onClick={handleCopyKey}>
                                                    Copy key first
                                                </Button>
                                                <Button
                                                    variant="primary"
                                                    size="lg"
                                                    onClick={() => dispatch({ type: 'CONFIRM_CONTINUE' })}
                                                >
                                                    Yes, continue
                                                </Button>
                                            </div>
                                        ) : (
                                            <Button
                                                variant="primary"
                                                size="lg"
                                                onClick={() => dispatch({ type: 'CONTINUE' })}
                                            >
                                                Continue
                                            </Button>
                                        )
                                    )}
                                    {state.step === 'install' && (
                                        <>
                                            <Button size="lg" onClick={() => dispatch({ type: 'BACK' })}>
                                                Back
                                            </Button>
                                            <Button variant="primary" size="lg" onClick={handleDone}>
                                                Done
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    )
}
