'use client'

import { useRef, useState, type Dispatch } from 'react'
import { createPortal } from 'react-dom'
import { Info, Sparkles } from 'lucide-react'
import { CLUSTER_NAME_HINT, CLUSTER_NAME_MAX_LENGTH, type WizardAction, type WizardState } from './newClusterWizard'

function InfoTooltip({ text }: { text: string }) {
    const [visible, setVisible] = useState(false)
    const [pos, setPos] = useState({ top: 0, left: 0 })
    const ref = useRef<HTMLSpanElement>(null)

    const show = () => {
        if (ref.current) {
            const rect = ref.current.getBoundingClientRect()
            setPos({ top: rect.top, left: rect.left + rect.width / 2 })
        }
        setVisible(true)
    }

    return (
        <>
            <span ref={ref} onMouseEnter={show} onMouseLeave={() => setVisible(false)} className="cursor-default leading-none">
                <Info className="size-3.5 text-ink-faint" />
            </span>
            {visible && createPortal(
                <div
                    className="fixed z-9999 -translate-x-1/2 -translate-y-full pointer-events-none"
                    style={{ top: pos.top - 6, left: pos.left }}
                >
                    <div className="w-56 rounded-md bg-ink px-2.5 py-1.5 text-xs text-surface shadow-floating">
                        {text}
                    </div>
                </div>,
                document.body,
            )}
        </>
    )
}

interface NewClusterDetailsStepProps {
    state: Extract<WizardState, { step: 'details' }>
    nameError: string | null
    dispatch: Dispatch<WizardAction>
    onSubmit: (e: React.FormEvent) => void
    /** Present only when the caller offers an upgrade path; already closes the dialog. */
    onUpgrade?: () => void
}

/** Step 1: name the cluster (and surface create/plan-limit errors). */
export function NewClusterDetailsStep({ state, nameError, dispatch, onSubmit, onUpgrade }: NewClusterDetailsStepProps) {
    const { name, nameTouched, isCreating, error, isPlanLimitError } = state

    return (
        <form id="new-cluster-form" onSubmit={onSubmit} className="space-y-4">
            <div>
                <label htmlFor="cluster-name" className="flex items-center gap-1.5 text-sm font-medium text-ink-secondary mb-2">
                    Name
                    <InfoTooltip text="Give it a name you'll recognise — ideally matching your kubectl context or ArgoCD cluster name." />
                </label>
                <input
                    id="cluster-name"
                    type="text"
                    value={name}
                    onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
                    onBlur={() => dispatch({ type: 'NAME_TOUCHED' })}
                    placeholder="Production EU"
                    maxLength={CLUSTER_NAME_MAX_LENGTH}
                    disabled={isCreating}
                    className={`w-full rounded-md bg-surface-raised border px-4 py-2.5 text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 disabled:opacity-50 transition-colors ${nameTouched && nameError ? 'border-danger-muted focus:ring-danger-emphasis focus:border-danger-emphasis' : 'border-edge-strong focus:ring-accent focus:border-accent'}`}
                    autoFocus
                    autoComplete="off"
                />
                {nameTouched && nameError ? (
                    <p className="mt-1.5 text-xs text-danger">{nameError}</p>
                ) : (
                    <p className="mt-1.5 text-xs text-ink-muted">{CLUSTER_NAME_HINT}</p>
                )}
            </div>

            {error && !isPlanLimitError && (
                <div className="bg-danger-subtle border border-danger-muted rounded-md p-3">
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}

            {isPlanLimitError && (
                <div className="rounded-md bg-attention-subtle border border-attention-muted p-4">
                    <div className="flex items-start gap-3">
                        <Sparkles className="size-4 text-attention mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-attention">Cluster limit reached</p>
                            <p className="text-xs text-attention mt-1">{error}</p>
                            {onUpgrade && (
                                <button
                                    type="button"
                                    onClick={onUpgrade}
                                    className="mt-2 text-xs font-semibold text-attention underline underline-offset-2 hover:text-attention cursor-pointer"
                                >
                                    Upgrade plan →
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </form>
    )
}
