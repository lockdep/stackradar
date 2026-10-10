// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client'

import { Fragment, useState } from 'react'
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react'
import { Check, MessageSquareText, X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/Button'

const MAX_LENGTH = 5000

interface FeedbackDialogProps {
    isOpen: boolean
    onClose: () => void
}

/**
 * The sidebar's "Send feedback" dialog. Free-form text, stored first-party
 * (POST /api/feedback) with the author and the page it was written on; it is
 * read back only on the admin dashboard's Feedback tab.
 */
export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
    const pathname = usePathname()
    const [message, setMessage] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sent, setSent] = useState(false)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()

        if (!message.trim()) {
            setError('Please write something first')
            return
        }

        setIsSubmitting(true)
        setError(null)

        try {
            const response = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message.trim(), page: pathname }),
            })

            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                throw new Error(data.error || 'Failed to send feedback')
            }

            setSent(true)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to send feedback')
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleClose = () => {
        if (isSubmitting) return
        onClose()
    }

    // Reset only once the leave transition has fully finished; a timer would
    // race the animation and flash the empty form while the panel fades out.
    const handleAfterLeave = () => {
        setMessage('')
        setError(null)
        setSent(false)
    }

    return (
        <Transition show={isOpen} as={Fragment} afterLeave={handleAfterLeave}>
            <Dialog as="div" className="relative z-50" onClose={handleClose}>
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
                            <DialogPanel className="relative w-full max-w-md transform overflow-hidden rounded-xl bg-surface-raised border border-edge p-6 shadow-floating transition-all">
                                <button
                                    onClick={handleClose}
                                    className="absolute top-4 right-4 p-1 text-ink-faint hover:text-ink transition-colors cursor-pointer"
                                >
                                    <X className="size-5" />
                                </button>

                                <div className="flex items-center gap-3 mb-6">
                                    <div className="shrink-0 p-2 bg-accent-subtle rounded-md">
                                        <MessageSquareText className="size-6 text-accent" />
                                    </div>
                                    <div>
                                        <DialogTitle className="text-lg font-semibold text-ink">
                                            Send feedback
                                        </DialogTitle>
                                        <p className="text-sm text-ink-muted">
                                            Bugs, ideas, anything — it goes straight to us
                                        </p>
                                    </div>
                                </div>

                                {sent ? (
                                    <div className="py-2 text-center">
                                        <div className="mx-auto size-12 rounded-full bg-success-emphasis/10 flex items-center justify-center mb-4">
                                            <Check className="size-6 text-success" />
                                        </div>
                                        <p className="text-ink font-medium">Thanks for the feedback!</p>
                                        <p className="text-sm text-ink-muted mt-1">
                                            We read every message.
                                        </p>
                                        <Button size="lg" fullWidth onClick={handleClose} className="mt-5">
                                            Close
                                        </Button>
                                    </div>
                                ) : (
                                    <form onSubmit={handleSubmit} className="space-y-4">
                                        <div>
                                            <label htmlFor="feedback-message" className="block text-sm font-medium text-ink-secondary mb-1">
                                                What&apos;s on your mind?
                                            </label>
                                            <textarea
                                                id="feedback-message"
                                                value={message}
                                                onChange={(e) => setMessage(e.target.value)}
                                                maxLength={MAX_LENGTH}
                                                rows={5}
                                                autoFocus
                                                placeholder="Something broken, missing, or confusing? Tell us."
                                                className="block w-full resize-y rounded-md bg-surface-muted border border-edge-strong px-3 py-2 text-sm text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                                                disabled={isSubmitting}
                                            />
                                        </div>

                                        {error && (
                                            <div className="bg-danger-subtle border border-danger-muted/30 rounded-md p-3">
                                                <p className="text-sm text-danger">{error}</p>
                                            </div>
                                        )}

                                        <div className="flex gap-3 pt-2">
                                            <Button size="lg" fullWidth onClick={handleClose} disabled={isSubmitting} type="button">
                                                Cancel
                                            </Button>
                                            <Button variant="primary" size="lg" fullWidth type="submit" loading={isSubmitting}>
                                                {isSubmitting ? 'Sending...' : 'Send feedback'}
                                            </Button>
                                        </div>
                                    </form>
                                )}
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    )
}
