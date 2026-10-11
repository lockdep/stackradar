'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { TIER_LENS_PARAM, lensHref, readStoredLens, resolveLens, storeLens, type TierLens } from '@/lib/tier-lens';

const subscribeToNothing = () => () => {};

/**
 * The findings lens for the current page, held in the URL — the bargain
 * `useSeverityFilter` makes: a lensed view is a link people paste, and the
 * digest and the Dashboard deep-link with `?tier=`.
 *
 * Precedence: the URL, then the reader's last explicit choice
 * (`localStorage`), then the page's `fallback` when it has a reason to open
 * wider, then the organization's default view, then "application". A choice is always written to the URL, the default
 * included: the default is per reader, so a link that left it out would show
 * its recipient a different list.
 *
 * Needs a Suspense boundary above it, like every `useSearchParams` reader.
 */
export function useTierLens(fallback?: TierLens): {
    lens: TierLens;
    setLens: (lens: TierLens) => void;
} {
    const router = useRouter();
    // A page's own reason to open wider (a third-party image) beats the
    // organization's default, which beats the product's ("application").
    const { organization } = useOrganization();
    const pageFallback: TierLens = fallback ?? organization?.defaultFindingTier ?? 'application';
    const pathname = usePathname();
    const searchParams = useSearchParams();

    /* Storage is read through `useSyncExternalStore` so the server render and
       the first client render agree (both see `null`), and the stored choice
       arrives without a setState-in-effect. */
    const stored = useSyncExternalStore(subscribeToNothing, readStoredLens, () => null);

    const lens = resolveLens(searchParams.get(TIER_LENS_PARAM), stored, pageFallback);

    const setLens = useCallback(
        (next: TierLens) => {
            storeLens(next);
            /* `replace`: choosing a lens refines one view, it does not navigate. */
            router.replace(lensHref(pathname, searchParams.toString(), next), { scroll: false });
        },
        [pathname, router, searchParams],
    );

    return { lens, setLens };
}
