/**
 * What a data fetch does when the BFF answers 401: the session behind the
 * page is gone (it expired while the tab sat open — two hours flat for the
 * live demo, a day idle otherwise), and nothing on the page can load again
 * until the browser goes back through the middleware. So reload. The
 * middleware then sends the visitor to `/login` with the current page as
 * the callback, or, in demo mode, through `/demo/enter` for a fresh session.
 *
 * Before reloading, ask `/api/auth/session` whether the session really is
 * gone. That is the one guard against a reload loop: if some other 401
 * ever reached a page that still has a session, reloading would only fetch
 * and 401 again. Several hooks 401 at the same instant when a stale tab
 * regains focus; the module-level flag folds them into one check and one
 * reload.
 *
 * Resolves `true` when a reload has been issued (the caller should stop
 * touching state) and `false` when the session is still there and the 401
 * is an ordinary error to surface.
 */

let pending: Promise<boolean> | null = null;

async function sessionIsGone(): Promise<boolean> {
    try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' });
        if (!res.ok) return false;
        const body: unknown = await res.json().catch(() => null);
        const user = body && typeof body === 'object' ? (body as { user?: unknown }).user : null;
        return !user;
    } catch {
        return false;
    }
}

export function reloadIfSessionLost(): Promise<boolean> {
    if (typeof window === 'undefined') return Promise.resolve(false);
    if (!pending) {
        pending = sessionIsGone().then((gone) => {
            if (gone) {
                window.location.reload();
                return true;
            }
            pending = null;
            return false;
        });
    }
    return pending;
}

/** Test seam: forget an in-flight check. */
export function resetSessionLostForTests(): void {
    pending = null;
}
