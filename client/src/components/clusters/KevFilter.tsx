'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui';

/** `?kev=true` — only what is on the CISA Known Exploited Vulnerabilities catalogue. */
export const KEV_PARAM = 'kev';

/**
 * The KEV filter, held in the URL like `useSeverityFilter` and for the same
 * reason: "everything known exploited" is a link people paste. Any value but
 * `true` is no filter.
 */
export function useKevFilter() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const kevOnly = searchParams.get(KEV_PARAM) === 'true';
    const toggleKev = useCallback(() => {
        const params = new URLSearchParams(searchParams.toString());
        if (kevOnly) params.delete(KEV_PARAM);
        else params.set(KEV_PARAM, 'true');
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, [kevOnly, pathname, router, searchParams]);

    return { kevOnly, toggleKev };
}

/** The toggle `useKevFilter` drives — on, it is drawn as the bar's menus draw a filter in force. */
export function KevFilterButton({ active, onToggle, noun }: { active: boolean; onToggle: () => void; noun: string }) {
    return (
        <Button
            variant={active ? 'selected' : 'secondary'}
            aria-pressed={active}
            onClick={onToggle}
            title={`Show only ${noun} on the CISA Known Exploited Vulnerabilities catalogue`}
        >
            <ShieldAlert aria-hidden className={`size-4 shrink-0 ${active ? 'text-accent' : 'text-ink-muted'}`} />
            Known exploited
        </Button>
    );
}
