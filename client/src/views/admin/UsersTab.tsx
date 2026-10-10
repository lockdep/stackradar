'use client'

import { Fragment, useState } from 'react'
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react'
import { KeyRound, Lock, ShieldCheck, UserPlus, X } from 'lucide-react'
import { Button, RelativeTime, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui'
import { PASSWORD_MIN_LENGTH } from '@/lib/local-login'
import { TabShell } from './Shared'
import { useTabData } from './useTabData'
import type { AdminUserRow } from '@/app/api/admin/users/route'

/**
 * Every account and how it signs in, with the two things an admin does for
 * local accounts (open-source plan step 04 §4): create one, and set or
 * reset its password. The data is the client's `users` table through
 * `/api/admin/users`, not Express — the server never sees a password.
 *
 * Drawn only when local login is on (`useRuntimeConfig().localLogin`, in
 * the admin page); the cloud's accounts are all OAuth and have nothing here
 * to manage.
 */

const INPUT =
    'block w-full rounded-md bg-surface-muted border border-edge-strong px-3 py-2 text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none'

const SIGN_IN_LABEL: Record<string, string> = {
    password: 'Password',
    github: 'GitHub',
    google: 'Google',
    oidc: 'OIDC',
}

export function UsersTab({ refreshKey, onLoadingChange }: { refreshKey: number; onLoadingChange: (v: boolean) => void }) {
    const { data, isLoading, error, refetch } = useTabData<{ users: AdminUserRow[] }>('/api/admin/users', refreshKey, onLoadingChange)
    const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'reset'; user: AdminUserRow } | null>(null)

    const rows = data?.users ?? []

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-muted">
                    {rows.length} {rows.length === 1 ? 'account' : 'accounts'}. Local accounts must change an admin-set password at their next sign-in.
                </p>
                <Button variant="primary" onClick={() => setDialog({ mode: 'create' })}>
                    <UserPlus className="size-4" aria-hidden="true" />
                    New local user
                </Button>
            </div>

            <TableContainer className="mt-4">
                <Table>
                    <TableHead>
                        <TableRow>
                            <TableHeader>Email</TableHeader>
                            <TableHeader>Name</TableHeader>
                            <TableHeader>Sign-in</TableHeader>
                            <TableHeader>Status</TableHeader>
                            <TableHeader>Created</TableHeader>
                            <TableHeader className="text-right">
                                <span className="sr-only">Actions</span>
                            </TableHeader>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((user) => {
                            const local = user.signIn.includes('password')
                            return (
                                <TableRow key={user.id}>
                                    <TableCell className="font-medium text-ink">
                                        <span className="inline-flex items-center gap-1.5">
                                            {user.email}
                                            {user.isAdmin && (
                                                <ShieldCheck className="size-3.5 text-accent" aria-label="Platform admin" />
                                            )}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-ink-secondary">{user.name ?? '—'}</TableCell>
                                    <TableCell className="text-ink-secondary">
                                        {user.signIn.length === 0 ? '—' : user.signIn.map((m) => SIGN_IN_LABEL[m] ?? m).join(', ')}
                                    </TableCell>
                                    <TableCell>
                                        <span className="inline-flex flex-wrap gap-1.5 text-xs">
                                            {user.lockedUntil && (
                                                <span className="inline-flex items-center gap-1 rounded-md bg-danger-subtle px-1.5 py-0.5 text-danger">
                                                    <Lock className="size-3" aria-hidden="true" />
                                                    Locked until {new Date(user.lockedUntil).toLocaleTimeString()}
                                                </span>
                                            )}
                                            {user.mustChangePassword && (
                                                <span className="rounded-md bg-attention-subtle px-1.5 py-0.5 text-attention">Must change password</span>
                                            )}
                                            {user.demo && <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-ink-muted">Demo</span>}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-ink-muted">
                                        <RelativeTime date={new Date(user.createdAt)} />
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {local && !user.demo && (
                                            <Button size="sm" onClick={() => setDialog({ mode: 'reset', user })}>
                                                <KeyRound className="size-3.5" aria-hidden="true" />
                                                Set password
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </TableContainer>

            <LocalUserDialog
                state={dialog}
                onClose={() => setDialog(null)}
                onDone={() => {
                    setDialog(null)
                    refetch()
                }}
            />
        </TabShell>
    )
}

/** 20 characters from a URL-safe alphabet: 119 bits, typed once into a password manager. */
function generatePassword(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    const bytes = new Uint8Array(20)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/**
 * One dialog for both jobs — create a local user, set an existing one's
 * password — because the shape is the same: a password the admin hands over,
 * which the account must then replace. "Generate" fills a random one and
 * shows it, so the admin copies it rather than inventing a weak one.
 */
function LocalUserDialog({
    state,
    onClose,
    onDone,
}: {
    state: { mode: 'create' } | { mode: 'reset'; user: AdminUserRow } | null
    onClose: () => void
    onDone: () => void
}) {
    const [email, setEmail] = useState('')
    const [name, setName] = useState('')
    const [password, setPassword] = useState('')
    const [isAdmin, setIsAdmin] = useState(false)
    const [showPassword, setShowPassword] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const open = state !== null
    const creating = state?.mode === 'create'

    const reset = () => {
        setEmail('')
        setName('')
        setPassword('')
        setIsAdmin(false)
        setShowPassword(false)
        setError(null)
    }
    const close = () => {
        if (busy) return
        reset()
        onClose()
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!state) return
        setBusy(true)
        setError(null)
        try {
            const res =
                state.mode === 'create'
                    ? await fetch('/api/admin/users', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined, password, isAdmin }),
                      })
                    : await fetch(`/api/admin/users/${state.user.id}/password`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ password }),
                      })
            const data = (await res.json().catch(() => ({}))) as { error?: string }
            if (!res.ok) {
                setError(data.error ?? 'Request failed')
                return
            }
            reset()
            onDone()
        } catch {
            setError('Could not reach the server.')
        } finally {
            setBusy(false)
        }
    }

    return (
        <Transition show={open} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={close}>
                <TransitionChild as={Fragment} enter="ease-out duration-300" enterFrom="opacity-0" enterTo="opacity-100" leave="ease-in duration-200" leaveFrom="opacity-100" leaveTo="opacity-0">
                    <div className="fixed inset-0 bg-backdrop" />
                </TransitionChild>
                <div className="fixed inset-0 z-10 overflow-y-auto">
                    <div className="flex min-h-full items-center justify-center p-4">
                        <TransitionChild as={Fragment} enter="ease-out duration-300" enterFrom="opacity-0 scale-95" enterTo="opacity-100 scale-100" leave="ease-in duration-200" leaveFrom="opacity-100 scale-100" leaveTo="opacity-0 scale-95">
                            <DialogPanel className="relative w-full max-w-md transform overflow-hidden rounded-xl bg-surface-raised border border-edge p-6 shadow-floating transition-all">
                                <button type="button" onClick={close} className="absolute top-4 right-4 p-1 text-ink-faint hover:text-ink transition-colors cursor-pointer" aria-label="Close">
                                    <X className="size-5" />
                                </button>

                                <DialogTitle className="text-lg font-semibold text-ink">
                                    {creating ? 'New local user' : 'Set password'}
                                </DialogTitle>
                                <p className="mt-1 text-sm text-ink-muted">
                                    {creating
                                        ? 'Hand the password over out of band. They must change it when they first sign in.'
                                        : state?.mode === 'reset'
                                          ? `${state.user.email} is signed out everywhere and must change this password at the next sign-in.`
                                          : ''}
                                </p>

                                <form onSubmit={submit} className="mt-5 space-y-4">
                                    {creating && (
                                        <>
                                            <div>
                                                <label htmlFor="new-user-email" className="block text-sm font-medium text-ink-secondary mb-1">Email</label>
                                                <input id="new-user-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} disabled={busy} />
                                            </div>
                                            <div>
                                                <label htmlFor="new-user-name" className="block text-sm font-medium text-ink-secondary mb-1">Name <span className="text-ink-muted">(optional)</span></label>
                                                <input id="new-user-name" type="text" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} disabled={busy} />
                                            </div>
                                        </>
                                    )}
                                    <div>
                                        <label htmlFor="new-user-password" className="block text-sm font-medium text-ink-secondary mb-1">
                                            {creating ? 'Initial password' : 'New password'}
                                        </label>
                                        <div className="flex gap-2">
                                            <input
                                                id="new-user-password"
                                                type={showPassword ? 'text' : 'password'}
                                                autoComplete="off"
                                                required
                                                minLength={PASSWORD_MIN_LENGTH}
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                className={`${INPUT} font-mono`}
                                                disabled={busy}
                                            />
                                            <Button
                                                type="button"
                                                size="lg"
                                                onClick={() => {
                                                    setPassword(generatePassword())
                                                    setShowPassword(true)
                                                }}
                                                disabled={busy}
                                                className="shrink-0"
                                            >
                                                Generate
                                            </Button>
                                        </div>
                                        <p className="mt-1 text-xs text-ink-muted">At least {PASSWORD_MIN_LENGTH} characters. Copy it before closing; it is not shown again.</p>
                                    </div>
                                    {creating && (
                                        <label className="flex items-center gap-2 text-sm text-ink-secondary">
                                            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} disabled={busy} className="size-4 rounded border-edge-strong accent-accent" />
                                            Platform admin (can open this dashboard)
                                        </label>
                                    )}

                                    {error && (
                                        <div role="alert" className="bg-danger-subtle border border-danger-muted/30 rounded-md p-3">
                                            <p className="text-sm text-danger">{error}</p>
                                        </div>
                                    )}

                                    <div className="flex gap-3 pt-2">
                                        <Button size="lg" type="button" onClick={close} disabled={busy} className="flex-1">Cancel</Button>
                                        <Button size="lg" type="submit" variant="primary" loading={busy} className="flex-1">
                                            {creating ? 'Create user' : 'Set password'}
                                        </Button>
                                    </div>
                                </form>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    )
}
