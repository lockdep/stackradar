'use client';

import { Fragment } from 'react';
import { Dialog, DialogPanel, Transition, TransitionChild } from '@headlessui/react';
import { X } from 'lucide-react';

/**
 * The shell of a read-only detail dialog — a page's worth of content over
 * the page the reader is on, so that reading up on one row does not cost a
 * navigation and, on return, a reload of every block (the app's
 * fetch-into-state hooks hold no cache).
 *
 * The chrome only: backdrop, a wide panel capped to the viewport, the close
 * button, the transitions. The caller renders its own header (with a
 * `DialogTitle`) and a scrollable body inside; the panel is a flex column so
 * a `min-h-0 overflow-y-auto` body scrolls under a fixed header.
 *
 * `afterLeave` fires once the fade-out has finished — the moment to drop the
 * content a caller kept mounted through the transition.
 *
 * `wide` is for content that is a table rather than prose.
 */
export function DetailDialog({
    isOpen,
    onClose,
    afterLeave,
    wide = false,
    children,
}: {
    isOpen: boolean;
    onClose: () => void;
    afterLeave?: () => void;
    wide?: boolean;
    children: React.ReactNode;
}) {
    return (
        <Transition show={isOpen} as={Fragment} afterLeave={afterLeave}>
            <Dialog as="div" className="relative z-50" onClose={onClose}>
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
                            <DialogPanel
                                className={`relative flex max-h-[calc(100vh-2rem)] w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'} transform flex-col overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-floating transition-all`}
                            >
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="absolute top-4 right-4 z-10 cursor-pointer rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink-secondary"
                                    aria-label="Close"
                                >
                                    <X className="size-5" />
                                </button>
                                {children}
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
