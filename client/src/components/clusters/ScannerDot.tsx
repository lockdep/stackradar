export type ScannerHealth = 'active' | 'stale' | 'offline' | 'waiting';

export function getScannerHealth(scannerLastSeenAt: string | null): ScannerHealth {
    /* Never-connected is not "offline": right after onboarding it means the
       scanner install simply hasn't phoned home yet, and the header polls
       until it does. Red would tell a brand-new user something is broken. */
    if (!scannerLastSeenAt) return 'waiting';
    const minutes = (Date.now() - new Date(scannerLastSeenAt).getTime()) / 60000;
    if (minutes < 5) return 'active';
    if (minutes < 60) return 'stale';
    return 'offline';
}

export function ScannerDot({ health }: { health: ScannerHealth }) {
    if (health === 'active') {
        return (
            <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-emphasis opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-success-emphasis" />
            </span>
        );
    }
    if (health === 'waiting') {
        /* Same pulse as active, in attention orange: "in progress", not "broken". */
        return (
            <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-attention-emphasis opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-attention-emphasis" />
            </span>
        );
    }
    if (health === 'stale') {
        return <span className="size-2 shrink-0 rounded-full bg-attention-emphasis" />;
    }
    return <span className="size-2 shrink-0 rounded-full bg-danger-emphasis" />;
}
