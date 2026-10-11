'use client';

import { useSyncExternalStore } from 'react';
import { Search } from 'lucide-react';
import { Kbd } from '@/components/ui';
import { useSearchPalette } from './SearchProvider';
import type { SearchSource } from './types';

const noop = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/**
 * `⌘` `K` on Apple platforms, `Ctrl` `K` elsewhere, as separate keycaps.
 * The server render has no platform and says ⌘; the client corrects it on
 * hydration without a mismatch, which is what `useSyncExternalStore`'s
 * server snapshot is for.
 */
function useShortcutKeys(): string[] {
    const apple = useSyncExternalStore(noop, isApplePlatform, () => true);
    return apple ? ['⌘', 'K'] : ['Ctrl', 'K'];
}

const SOURCE: Record<'sidebar' | 'icon', SearchSource> = {
    sidebar: 'sidebar',
    icon: 'mobile',
};

/**
 * The button that opens the palette. It looks like an input where it stands
 * in for one (`sidebar`) but never holds text itself: the palette owns the
 * query.
 */
export function SearchTrigger({ variant, className = '' }: { variant: 'sidebar' | 'icon'; className?: string }) {
    const { open } = useSearchPalette();
    const shortcut = useShortcutKeys();
    const source = SOURCE[variant];

    if (variant === 'icon') {
        return (
            <button
                type="button"
                onClick={() => open('', source)}
                className={`-m-2 cursor-pointer p-2 text-ink-muted hover:text-ink-secondary ${className}`}
            >
                <span className="sr-only">Search</span>
                <Search aria-hidden="true" className="size-5" />
            </button>
        );
    }

    /* The sidebar variant is drawn as a field, not a nav item: a hairline
       border on the raised surface, 32px tall, the caps flush right — the
       shape PostHog and Linear give the same control, which is what makes
       it read as "type here" among plain links. */
    return (
        <button
            type="button"
            onClick={() => open('', source)}
            className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-edge bg-surface-raised px-2 text-sm text-ink-muted hover:border-edge-strong hover:bg-surface-hover/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
        >
            <Search aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate text-left">Search…</span>
            <Kbd keys={shortcut} />
        </button>
    );
}
