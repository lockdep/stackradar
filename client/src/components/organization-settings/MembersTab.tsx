'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2 } from 'lucide-react'
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
} from '@/components/ui'
import { RoleBadge } from './RoleBadge'
import type { Member } from './types'

interface MembersTabProps {
    orgId: string
    currentRole: string
    currentUserId: string
}

export function MembersTab({ orgId, currentRole, currentUserId }: MembersTabProps) {
    const [members, setMembers] = useState<Member[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showInviteDialog, setShowInviteDialog] = useState(false)
    const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)
    const [changingRoleId, setChangingRoleId] = useState<string | null>(null)

    const canManageMembers = currentRole === 'owner' || currentRole === 'admin'

    const fetchMembers = useCallback(async () => {
        setIsLoading(true)
        setError(null)

        try {
            const response = await fetch(`/api/organizations/${orgId}/members`)
            if (!response.ok) {
                throw new Error('Failed to load members')
            }
            const data = await response.json()
            setMembers(data.members || [])
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load members')
        } finally {
            setIsLoading(false)
        }
    }, [orgId])

    useEffect(() => {
        fetchMembers()
    }, [fetchMembers])

    const handleRemoveMember = async (memberId: string) => {
        setRemovingMemberId(memberId)
        try {
            const response = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
                method: 'DELETE',
            })
            if (!response.ok) {
                const data = await response.json()
                throw new Error(data.error || 'Failed to remove member')
            }
            setMembers(members.filter(m => m.id !== memberId))
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to remove member')
        } finally {
            setRemovingMemberId(null)
        }
    }

    const handleChangeRole = async (memberId: string, newRole: 'admin' | 'member') => {
        setChangingRoleId(memberId)
        try {
            const response = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: newRole }),
            })
            if (!response.ok) {
                const data = await response.json()
                throw new Error(data.error || 'Failed to update role')
            }
            setMembers(members.map(m => m.id === memberId ? { ...m, role: newRole } : m))
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update role')
        } finally {
            setChangingRoleId(null)
        }
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Spinner size="lg" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 className="text-lg font-medium text-ink">Team Members</h3>
                    <p className="text-sm text-ink-muted">{members.length} member{members.length !== 1 ? 's' : ''}</p>
                </div>
                {canManageMembers && (
                    <Button variant="primary" onClick={() => setShowInviteDialog(true)}>
                        <Plus className="size-4" />
                        Invite Member
                    </Button>
                )}
            </div>

            {error && (
                <div className="bg-danger-subtle border border-danger-muted rounded-md p-4">
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}

            <TableContainer>
                <Table density="spacious" aria-label="Members">
                    <TableHead>
                        <TableHeader>Member</TableHeader>
                        <TableHeader>Role</TableHeader>
                        {/* The join date is the one column a phone goes without. */}
                        <TableHeader hideBelow="md">Joined</TableHeader>
                        {canManageMembers && <TableHeader srOnly>Actions</TableHeader>}
                    </TableHead>
                    <TableBody>
                        {members.map((member) => {
                            const isCurrentUser = member.id === currentUserId
                            const isOwner = member.role === 'owner'
                            const canModify = canManageMembers && !isOwner && !isCurrentUser

                            return (
                                <TableRow key={member.id} hoverable>
                                    {/* Not `whitespace-nowrap`: the email is the
                                        widest thing in the row and must be allowed
                                        to break on a phone. */}
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            {member.image ? (
                                                <img src={member.image} alt="" className="size-8 shrink-0 rounded-full" />
                                            ) : (
                                                <div className="size-8 shrink-0 rounded-full bg-accent-emphasis flex items-center justify-center text-on-emphasis text-sm font-medium">
                                                    {(member.name || member.email).charAt(0).toUpperCase()}
                                                </div>
                                            )}
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-medium text-ink sm:text-sm">{member.name || 'Unknown'}</span>
                                                    {isCurrentUser && <span className="text-xs text-ink-muted">(you)</span>}
                                                </div>
                                                <div className="text-xs text-ink-muted break-all sm:text-sm">{member.email}</div>
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">
                                        <RoleBadge role={member.role} />
                                    </TableCell>
                                    <TableCell hideBelow="md" className="whitespace-nowrap text-ink-muted">
                                        {new Date(member.joinedAt).toLocaleDateString()}
                                    </TableCell>
                                    {canManageMembers && (
                                        <TableCell align="end" className="whitespace-nowrap">
                                            {canModify && (
                                                <div className="flex items-center justify-end gap-2">
                                                    <select
                                                        value={member.role}
                                                        onChange={(e) => handleChangeRole(member.id, e.target.value as 'admin' | 'member')}
                                                        disabled={changingRoleId === member.id}
                                                        className="rounded-md bg-surface-raised border border-edge-strong px-2 py-1 text-sm text-ink focus:border-accent focus:ring-1 focus:ring-accent outline-none disabled:opacity-50"
                                                    >
                                                        <option value="member">Member</option>
                                                        <option value="admin">Admin</option>
                                                    </select>
                                                    <button
                                                        onClick={() => handleRemoveMember(member.id)}
                                                        disabled={removingMemberId === member.id}
                                                        className="p-1.5 text-ink-faint hover:text-danger hover:bg-danger-subtle rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                                                        title="Remove member"
                                                    >
                                                        {removingMemberId === member.id ? (
                                                            <Spinner size="sm" />
                                                        ) : (
                                                            <Trash2 className="size-4" />
                                                        )}
                                                    </button>
                                                </div>
                                            )}
                                        </TableCell>
                                    )}
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </TableContainer>

            <InviteMemberDialog
                isOpen={showInviteDialog}
                onClose={() => setShowInviteDialog(false)}
                orgId={orgId}
                onInviteSent={() => setShowInviteDialog(false)}
            />
        </div>
    )
}
