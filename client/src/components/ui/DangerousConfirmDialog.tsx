'use client'

import { Fragment, useState, useEffect } from 'react'
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react'
import { TriangleAlert } from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'

interface DangerousConfirmDialogProps {
    isOpen: boolean
    onClose: () => void
    onConfirm: () => void
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    confirmationWord?: string
    isLoading?: boolean
}

export function DangerousConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = 'Delete',
    cancelText = 'Cancel',
    confirmationWord = 'DELETE',
    isLoading = false,
}: DangerousConfirmDialogProps) {
    const [inputValue, setInputValue] = useState('')
    
    const isConfirmEnabled = inputValue === confirmationWord

    // Reset input when dialog opens/closes
    useEffect(() => {
        if (!isOpen) {
            setInputValue('')
        }
    }, [isOpen])

    const handleClose = () => {
        if (!isLoading) {
            onClose()
        }
    }

    const handleConfirm = () => {
        if (isConfirmEnabled && !isLoading) {
            onConfirm()
        }
    }

    return (
        <Transition show={isOpen} as={Fragment}>
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
                                <div className="flex items-start gap-4">
                                    <div className="shrink-0 p-2 rounded-md bg-danger-emphasis/10">
                                        <TriangleAlert className="size-6 text-danger" />
                                    </div>
                                    <div className="flex-1">
                                        <DialogTitle className="text-lg font-semibold text-ink">
                                            {title}
                                        </DialogTitle>
                                        <p className="mt-2 text-sm text-ink-muted">
                                            {message}
                                        </p>
                                    </div>
                                </div>

                                <div className="mt-6">
                                    <label className="block text-sm font-medium text-ink-secondary mb-2">
                                        Type <span className="font-mono text-danger bg-danger-emphasis/10 px-1.5 py-0.5 rounded-sm">{confirmationWord}</span> to confirm
                                    </label>
                                    <input
                                        type="text"
                                        value={inputValue}
                                        onChange={(e) => setInputValue(e.target.value)}
                                        disabled={isLoading}
                                        className="block w-full rounded-md bg-surface-muted border border-edge-strong px-3 py-2.5 text-ink placeholder-ink-faint focus:border-danger-muted focus:ring-1 focus:ring-danger-emphasis outline-none disabled:opacity-50"
                                        placeholder={confirmationWord}
                                        autoComplete="off"
                                        spellCheck={false}
                                    />
                                </div>

                                <div className="flex gap-3 mt-6">
                                    <button
                                        type="button"
                                        onClick={handleClose}
                                        disabled={isLoading}
                                        className="flex-1 px-4 py-2.5 bg-btn-secondary hover:bg-btn-secondary-hover border border-edge text-ink font-medium rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                                    >
                                        {cancelText}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleConfirm}
                                        disabled={!isConfirmEnabled || isLoading}
                                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-danger-emphasis hover:bg-danger-emphasis-hover disabled:bg-danger-emphasis/50 text-on-emphasis font-medium rounded-md transition-colors disabled:cursor-not-allowed cursor-pointer"
                                    >
                                        {isLoading ? (
                                            <>
                                                <Spinner size="sm" />
                                                Deleting...
                                            </>
                                        ) : (
                                            confirmText
                                        )}
                                    </button>
                                </div>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    )
}
