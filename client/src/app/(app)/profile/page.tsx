'use client';

import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { ThemeToggle, buttonClasses } from '@/components/ui';
import { useRuntimeConfig } from '@/components/providers';

export default function ProfilePage() {
    const { localLogin } = useRuntimeConfig();

    return (
        <div>
            <h1 className="text-2xl font-bold text-ink mb-6">Profile</h1>

            <div className="max-w-lg bg-surface-raised border border-edge rounded-md p-5">
                <h2 className="text-sm font-semibold text-ink">Appearance</h2>
                <p className="mt-1 text-sm text-ink-muted">
                    Choose how StackRadar looks. &ldquo;System&rdquo; follows your operating system preference.
                </p>
                <div className="mt-4">
                    <ThemeToggle showLabels />
                </div>
            </div>

            {/* Local username/password sign-in. The
                page it links to knows whether this account has a password at
                all; an OAuth account gets told so there, not hidden from here,
                because "where is my password" deserves an answer. */}
            {localLogin && (
                <div className="mt-6 max-w-lg bg-surface-raised border border-edge rounded-md p-5">
                    <h2 className="text-sm font-semibold text-ink">Password</h2>
                    <p className="mt-1 text-sm text-ink-muted">
                        Changing it signs out every other session of this account.
                    </p>
                    <div className="mt-4">
                        <Link href="/account/password" className={buttonClasses({ size: 'md' })}>
                            <KeyRound className="size-4" aria-hidden="true" />
                            Change password
                        </Link>
                    </div>
                </div>
            )}

            <p className="mt-6 text-ink-muted">Profile settings and information...</p>
        </div>
    );
}
