'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { Building2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useOrganization, type Organization } from '@/components/providers';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';

interface CreateOrganizationModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function CreateOrganizationModal({ isOpen, onClose }: CreateOrganizationModalProps) {
    const { addOrganization } = useOrganization();
    const router = useRouter();
    const [name, setName] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Set when the server refused because the user already has a free org
    // (code FREE_ORG_LIMIT): the fix is to upgrade that org, so the error
    // carries a link to billing instead of being a dead end.
    const [isFreeOrgLimit, setIsFreeOrgLimit] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!name.trim()) {
            setError('Organization name is required');
            return;
        }

        if (name.trim().length < 2) {
            setError('Name must be at least 2 characters');
            return;
        }

        setIsLoading(true);
        setError(null);
        setIsFreeOrgLimit(false);

        try {
            const data = await apiFetch<{ organization: Organization }>('/api/users/organizations', {
                method: 'POST',
                json: { name: name.trim() },
            });

            // Add the new organization and switch to it
            addOrganization(data.organization, true);

            // Reset form and close modal
            setName('');
            onClose();
        } catch (err) {
            if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === 'FREE_ORG_LIMIT') {
                setIsFreeOrgLimit(true);
            }
            setError(errorMessage(err, 'Failed to create organization'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleClose = () => {
        if (!isLoading) {
            setName('');
            setError(null);
            setIsFreeOrgLimit(false);
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
                                <div className="flex items-start gap-4 mb-6">
                                    <div className="shrink-0 p-2 rounded-md bg-success-emphasis/10">
                                        <Building2 className="size-6 text-accent" />
                                    </div>
                                    <div className="flex-1">
                                        <DialogTitle className="text-lg font-semibold text-ink">
                                            Create organization
                                        </DialogTitle>
                                        <p className="mt-1 text-sm text-ink-muted">
                                            Set up a new workspace for your team
                                        </p>
                                    </div>
                                </div>

                                <form onSubmit={handleSubmit}>
                                    <div className="mb-6">
                                        <label
                                            htmlFor="org-name"
                                            className="block text-sm font-medium text-ink-secondary mb-2"
                                        >
                                            Organization name
                                        </label>
                                        <input
                                            id="org-name"
                                            type="text"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            placeholder="Acme Inc."
                                            disabled={isLoading}
                                            className="w-full rounded-md bg-surface-muted border border-edge-strong px-4 py-2.5 text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50 disabled:opacity-50 transition-colors"
                                            autoFocus
                                        />
                                        {error && (
                                            <p className="mt-2 text-sm text-danger">
                                                {error}
                                                {isFreeOrgLimit && (
                                                    <>
                                                        {' '}
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                handleClose();
                                                                router.push('/org-settings?tab=billing');
                                                            }}
                                                            className="font-medium underline underline-offset-2 hover:text-ink"
                                                        >
                                                            Upgrade plan
                                                        </button>
                                                    </>
                                                )}
                                            </p>
                                        )}
                                    </div>

                                    <div className="flex gap-3">
                                        <Button size="lg" onClick={handleClose} disabled={isLoading} className="flex-1">
                                            Cancel
                                        </Button>
                                        <Button
                                            type="submit"
                                            variant="primary"
                                            size="lg"
                                            disabled={!name.trim()}
                                            loading={isLoading}
                                            className="flex-1"
                                        >
                                            {isLoading ? 'Creating...' : 'Create organization'}
                                        </Button>
                                    </div>
                                </form>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
