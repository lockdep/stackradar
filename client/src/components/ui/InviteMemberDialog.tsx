'use client';

import { Fragment, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Link2, Mail, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';

interface InviteMemberDialogProps {
    isOpen: boolean;
    onClose: () => void;
    orgId: string;
    onInviteSent: () => void;
}

export function InviteMemberDialog({ isOpen, onClose, orgId, onInviteSent }: InviteMemberDialogProps) {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<'member' | 'admin'>('member');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isPlanLimitError, setIsPlanLimitError] = useState(false);
    const router = useRouter();
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!email.trim()) {
            setError('Email is required');
            return;
        }

        setIsSubmitting(true);
        setError(null);
        setIsPlanLimitError(false);

        try {
            const data = await apiFetch<{ invite?: { inviteUrl?: string } }>(`/api/organizations/${orgId}/invites`, {
                method: 'POST',
                json: { email: email.trim().toLowerCase(), role },
            });

            // Stay open so the admin can copy the link — there is no email
            // delivery; sharing this link is how the invitee joins.
            setInviteUrl(data.invite?.inviteUrl ?? null);
        } catch (err) {
            // The server tags plan-limit rejections with a machine-readable
            // code; matching on the bare 403 would render any future
            // authorization failure as an upgrade prompt.
            if (
                err instanceof ApiError &&
                (err.body as { code?: string } | undefined)?.code === 'PLAN_LIMIT_EXCEEDED'
            ) {
                setIsPlanLimitError(true);
            }
            setError(errorMessage(err, 'Failed to create invite'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCopy = async () => {
        if (!inviteUrl) return;
        try {
            await navigator.clipboard.writeText(inviteUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable (e.g. insecure context) — the input below
            // remains selectable as a fallback.
        }
    };

    const handleUpgrade = () => {
        onClose();
        router.push('/org-settings?tab=billing');
    };

    const handleClose = () => {
        if (!isSubmitting) {
            const created = inviteUrl !== null;
            setEmail('');
            setRole('member');
            setError(null);
            setIsPlanLimitError(false);
            setInviteUrl(null);
            setCopied(false);
            if (created) {
                onInviteSent();
            } else {
                onClose();
            }
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
                                <button
                                    onClick={handleClose}
                                    className="absolute top-4 right-4 p-1 text-ink-faint hover:text-ink transition-colors cursor-pointer"
                                >
                                    <X className="size-5" />
                                </button>

                                <div className="flex items-center gap-3 mb-6">
                                    <div className="shrink-0 p-2 bg-success-emphasis/10 rounded-md">
                                        <Mail className="size-6 text-accent" />
                                    </div>
                                    <div>
                                        <DialogTitle className="text-lg font-semibold text-ink">
                                            Invite Team Member
                                        </DialogTitle>
                                        <p className="text-sm text-ink-muted">Create an invite link to share</p>
                                    </div>
                                </div>

                                {inviteUrl ? (
                                    <div className="py-2">
                                        <div className="text-center mb-5">
                                            <div className="mx-auto size-12 rounded-full bg-success-emphasis/10 flex items-center justify-center mb-4">
                                                <Link2 className="size-6 text-accent" />
                                            </div>
                                            <p className="text-ink font-medium">Invite created</p>
                                            <p className="text-sm text-ink-muted mt-1">
                                                Share this link with {email}. It expires in 7 days and only works for
                                                that email address.
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="text"
                                                readOnly
                                                value={inviteUrl}
                                                onFocus={(e) => e.target.select()}
                                                className="block w-full rounded-md bg-surface-muted border border-edge-strong px-3 py-2 text-sm text-ink outline-none"
                                            />
                                            <Button
                                                variant="primary"
                                                size="lg"
                                                onClick={handleCopy}
                                                className="shrink-0"
                                            >
                                                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                                {copied ? 'Copied' : 'Copy'}
                                            </Button>
                                        </div>
                                        <Button size="lg" fullWidth onClick={handleClose} className="mt-4">
                                            Done
                                        </Button>
                                    </div>
                                ) : (
                                    <form onSubmit={handleSubmit} className="space-y-4">
                                        <div>
                                            <label
                                                htmlFor="email"
                                                className="block text-sm font-medium text-ink-secondary mb-1"
                                            >
                                                Email address
                                            </label>
                                            <input
                                                type="email"
                                                id="email"
                                                value={email}
                                                onChange={(e) => setEmail(e.target.value)}
                                                placeholder="colleague@company.com"
                                                className="block w-full rounded-md bg-surface-muted border border-edge-strong px-3 py-2 text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                                                disabled={isSubmitting}
                                            />
                                        </div>

                                        <div>
                                            <label
                                                htmlFor="role"
                                                className="block text-sm font-medium text-ink-secondary mb-1"
                                            >
                                                Role
                                            </label>
                                            <select
                                                id="role"
                                                value={role}
                                                onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
                                                className="block w-full rounded-md bg-surface-muted border border-edge-strong px-3 py-2 text-ink focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                                                disabled={isSubmitting}
                                            >
                                                <option value="member">Member - Can view containers and SBOMs</option>
                                                <option value="admin">Admin - Can manage members and settings</option>
                                            </select>
                                        </div>

                                        {error && !isPlanLimitError && (
                                            <div className="bg-danger-subtle border border-danger-muted/30 rounded-md p-3">
                                                <p className="text-sm text-danger">{error}</p>
                                            </div>
                                        )}

                                        {isPlanLimitError && (
                                            <div className="rounded-md bg-attention-subtle border border-attention-muted p-4">
                                                <div className="flex items-start gap-3">
                                                    <Sparkles className="size-4 text-attention mt-0.5 shrink-0" />
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-attention">
                                                            Member limit reached
                                                        </p>
                                                        <p className="text-xs text-attention mt-1">{error}</p>
                                                        <button
                                                            type="button"
                                                            onClick={handleUpgrade}
                                                            className="mt-2 text-xs font-semibold text-attention underline underline-offset-2 hover:text-attention cursor-pointer"
                                                        >
                                                            Upgrade plan →
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex gap-3 pt-2">
                                            <Button
                                                size="lg"
                                                onClick={handleClose}
                                                disabled={isSubmitting}
                                                className="flex-1"
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                type="submit"
                                                variant="primary"
                                                size="lg"
                                                loading={isSubmitting}
                                                className="flex-1"
                                            >
                                                {isSubmitting ? 'Creating...' : 'Create Invite'}
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
    );
}
