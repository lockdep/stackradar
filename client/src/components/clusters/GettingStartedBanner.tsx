'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { CheckCircle2, Circle, X, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui'

interface GettingStartedBannerProps {
    hasCluster: boolean
    hasContainers: boolean
    isLoading: boolean
    /** Connecting a cluster is admin/owner-only; members see the steps without the CTA. */
    canConnect: boolean
    onConnectCluster: () => void
}

export function GettingStartedBanner({ hasCluster, hasContainers, isLoading, canConnect, onConnectCluster }: GettingStartedBannerProps) {
    const { data: session } = useSession()
    const [dismissed, setDismissed] = useState(false)
    const [mounted, setMounted] = useState(false)

    const storageKey = session?.user?.id ? `sr_onboarding_dismissed_${session.user.id}` : null

    useEffect(() => {
        setMounted(true)
        if (storageKey) {
            setDismissed(localStorage.getItem(storageKey) === 'true')
        }
    }, [storageKey])

    const allComplete = hasCluster && hasContainers
    const shouldShow = mounted && !isLoading && !allComplete && (!dismissed || !hasCluster)

    useEffect(() => {
        if (mounted && allComplete && storageKey) {
            localStorage.setItem(storageKey, 'true')
        }
    }, [mounted, allComplete, storageKey])

    const handleDismiss = () => {
        if (storageKey) {
            localStorage.setItem(storageKey, 'true')
        }
        setDismissed(true)
    }

    if (!shouldShow) return null

    const steps = [
        { label: 'Create your account', done: true },
        { label: 'Connect a cluster', done: hasCluster, action: !hasCluster && canConnect ? onConnectCluster : undefined, actionLabel: 'Connect' },
        { label: 'Verify containers appear', done: hasContainers },
    ]

    const completedCount = steps.filter(s => s.done).length

    return (
        /* Neutral panel, not a green one. Every element here used to be
           `text-success` — including the *incomplete* steps, which made unfinished
           work read as done. Green is reserved for the tick on completed steps. */
        <div className="mb-6 rounded-md border border-edge bg-surface-raised px-4 py-3">
            <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                        <p className="text-sm font-semibold text-ink">Getting started</p>
                        <span className="text-xs text-ink-muted">{completedCount}/{steps.length} complete</span>
                    </div>
                    <ul className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                        {steps.map(step => (
                            <li key={step.label} className="flex items-center gap-1.5 text-sm">
                                {step.done ? (
                                    <CheckCircle2 className="size-4 text-success shrink-0" />
                                ) : (
                                    <Circle className="size-4 text-ink-faint shrink-0" />
                                )}
                                <span className={step.done ? 'text-ink-muted line-through' : 'text-ink-secondary'}>
                                    {step.label}
                                </span>
                                {step.action && (
                                    <Button variant="primary" size="sm" onClick={step.action} className="ml-1">
                                        {step.actionLabel}
                                        <ArrowRight className="size-3" />
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
                <button
                    onClick={handleDismiss}
                    className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-btn-secondary-hover hover:text-ink cursor-pointer"
                    aria-label="Dismiss"
                >
                    <X className="size-4" />
                </button>
            </div>
        </div>
    )
}
