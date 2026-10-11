'use client';

import { useState } from 'react';
import { Plus, Mail, Check, Copy } from 'lucide-react';
import {
    Button,
    InviteMemberDialog,
    Spinner,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui';
import { useResource } from '@/hooks';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { RoleBadge } from './RoleBadge';
import type { Invite } from './types';

interface InvitesTabProps {
    orgId: string;
}

export function InvitesTab({ orgId }: InvitesTabProps) {
    /* `loadingOnRefetch`: a new invite reloads the list behind the spinner, as it always has. */
    const {
        data,
        isLoading,
        error: loadError,
        refetch: fetchInvites,
    } = useResource<Invite[]>(`/api/organizations/${orgId}/invites`, {
        select: (body) => (body as { invites?: Invite[] }).invites || [],
        responseError: () => 'Failed to load invites',
        fallbackError: 'Failed to load invites',
        loadingOnRefetch: true,
    });
    const invites = data ?? [];
    const [actionError, setActionError] = useState<string | null>(null);
    const error = actionError ?? loadError;
    const [showInviteDialog, setShowInviteDialog] = useState(false);
    const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(null);
    const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

    const handleCopyLink = async (invite: Invite) => {
        try {
            await navigator.clipboard.writeText(invite.inviteUrl);
            setCopiedInviteId(invite.id);
            setTimeout(() => setCopiedInviteId(null), 2000);
        } catch {
            setActionError('Failed to copy link to clipboard');
        }
    };

    const handleCancelInvite = async (inviteId: string) => {
        setCancellingInviteId(inviteId);
        setActionError(null);
        try {
            await apiFetch(`/api/organizations/${orgId}/invites/${inviteId}`, { method: 'DELETE' });
            await fetchInvites();
        } catch (err) {
            setActionError(errorMessage(err, 'Failed to cancel invite'));
        } finally {
            setCancellingInviteId(null);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Spinner size="lg" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 className="text-lg font-medium text-ink">Pending Invites</h3>
                    <p className="text-sm text-ink-muted">
                        {invites.length} pending invite{invites.length !== 1 ? 's' : ''}
                    </p>
                </div>
                <Button variant="primary" onClick={() => setShowInviteDialog(true)}>
                    <Plus className="size-4" />
                    Invite Member
                </Button>
            </div>

            {error && (
                <div className="bg-danger-subtle border border-danger-muted rounded-md p-4">
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}

            {invites.length === 0 ? (
                <div className="rounded-md bg-surface-raised border border-edge p-8 text-center">
                    <Mail className="mx-auto size-12 text-ink-faint" />
                    <h3 className="mt-4 text-sm font-medium text-ink">No pending invites</h3>
                    <p className="mt-2 text-sm text-ink-muted">Invite team members to collaborate on your clusters.</p>
                </div>
            ) : (
                <TableContainer>
                    <Table density="spacious" aria-label="Pending invites">
                        <TableHead>
                            <TableHeader>Email</TableHeader>
                            <TableHeader>Role</TableHeader>
                            {/* A phone keeps the invitee, the role and the two
                                actions; who sent it returns at `sm`, the
                                expiry at `md`. */}
                            <TableHeader hideBelow="sm">Invited by</TableHeader>
                            <TableHeader hideBelow="md">Expires</TableHeader>
                            <TableHeader srOnly>Actions</TableHeader>
                        </TableHead>
                        <TableBody>
                            {invites.map((invite) => (
                                <TableRow key={invite.id} hoverable>
                                    {/* `break-all`, not `whitespace-nowrap`: the
                                        email is the widest thing in the row. */}
                                    <TableCell className="text-ink break-all">{invite.email}</TableCell>
                                    <TableCell className="whitespace-nowrap">
                                        <RoleBadge role={invite.role} />
                                    </TableCell>
                                    <TableCell hideBelow="sm" className="whitespace-nowrap text-ink-muted">
                                        {invite.invitedBy.name || invite.invitedBy.email}
                                    </TableCell>
                                    <TableCell hideBelow="md" className="whitespace-nowrap text-ink-muted">
                                        {new Date(invite.expiresAt).toLocaleDateString()}
                                    </TableCell>
                                    <TableCell align="end" className="whitespace-nowrap">
                                        <div className="flex items-center justify-end gap-3">
                                            <button
                                                onClick={() => handleCopyLink(invite)}
                                                className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors cursor-pointer"
                                                title="Copy invite link"
                                            >
                                                {copiedInviteId === invite.id ? (
                                                    <>
                                                        <Check className="size-4 text-accent" />
                                                        Copied
                                                    </>
                                                ) : (
                                                    <>
                                                        <Copy className="size-4" />
                                                        Copy link
                                                    </>
                                                )}
                                            </button>
                                            <button
                                                onClick={() => handleCancelInvite(invite.id)}
                                                disabled={cancellingInviteId === invite.id}
                                                className="text-ink-muted hover:text-danger transition-colors disabled:opacity-50 cursor-pointer"
                                            >
                                                {cancellingInviteId === invite.id ? <Spinner size="sm" /> : 'Cancel'}
                                            </button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}

            <InviteMemberDialog
                isOpen={showInviteDialog}
                onClose={() => setShowInviteDialog(false)}
                orgId={orgId}
                onInviteSent={() => {
                    setShowInviteDialog(false);
                    void fetchInvites();
                }}
            />
        </div>
    );
}
