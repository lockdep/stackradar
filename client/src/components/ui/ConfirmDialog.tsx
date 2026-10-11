'use client';

import { Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
    isLoading?: boolean;
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isDestructive = false,
    isLoading = false,
}: ConfirmDialogProps) {
    const handleClose = () => {
        if (!isLoading) {
            onClose();
        }
    };

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
                                    <div
                                        className={`shrink-0 p-2 rounded-md ${isDestructive ? 'bg-danger-emphasis/10' : 'bg-attention-emphasis/10'}`}
                                    >
                                        <TriangleAlert
                                            className={`size-6 ${isDestructive ? 'text-danger' : 'text-attention'}`}
                                        />
                                    </div>
                                    <div className="flex-1">
                                        <DialogTitle className="text-lg font-semibold text-ink">{title}</DialogTitle>
                                        <p className="mt-2 text-sm text-ink-muted">{message}</p>
                                    </div>
                                </div>

                                <div className="flex gap-3 mt-6">
                                    <Button size="lg" onClick={handleClose} disabled={isLoading} className="flex-1">
                                        {cancelText}
                                    </Button>
                                    <Button
                                        variant={isDestructive ? 'danger' : 'primary'}
                                        size="lg"
                                        onClick={onConfirm}
                                        loading={isLoading}
                                        className="flex-1"
                                    >
                                        {isLoading ? 'Processing...' : confirmText}
                                    </Button>
                                </div>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
