"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

const INPUT =
    "block w-full rounded-md bg-surface-raised border border-edge-strong px-3 py-2 text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none";

/**
 * Email and password, posted to `/api/auth/local`. The route answers with
 * `redirectTo` — `/account/password` for a password that must be changed,
 * the page's `callbackUrl` otherwise — and the form follows it with a full
 * navigation so the proxy reads the new session cookie on the next request.
 *
 * One error message for every refusal, as the route sends it: the form does
 * not know, and must not guess, which part was wrong.
 */
export function LocalLoginForm({ callbackUrl }: { callbackUrl: string }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const res = await fetch("/api/auth/local", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password, callbackUrl }),
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string; redirectTo?: string };
            if (!res.ok) {
                setError(data.error ?? "Sign-in failed.");
                setBusy(false);
                return;
            }
            window.location.assign(data.redirectTo ?? "/");
        } catch {
            setError("Could not reach the server.");
            setBusy(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="space-y-3">
            <div>
                <label htmlFor="login-email" className="block text-sm font-medium text-ink-secondary mb-1">
                    Email
                </label>
                <input
                    id="login-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={INPUT}
                    disabled={busy}
                />
            </div>
            <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-ink-secondary mb-1">
                    Password
                </label>
                <input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={INPUT}
                    disabled={busy}
                />
            </div>
            {error && (
                <div role="alert" className="bg-danger-subtle border border-danger-muted/30 rounded-md p-3">
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}
            <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} className="h-11 text-[15px]">
                Sign in
            </Button>
        </form>
    );
}
