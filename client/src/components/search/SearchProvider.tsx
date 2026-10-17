'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { capture } from '@/lib/analytics';
import { SearchPalette } from './SearchPalette';
import type { SearchSource } from './types';

type SearchPaletteContext = {
    /** Open the palette, optionally with a first character already typed. */
    open: (initialQuery?: string, source?: SearchSource) => void;
    close: () => void;
    isOpen: boolean;
};

const Context = createContext<SearchPaletteContext | null>(null);

export function useSearchPalette(): SearchPaletteContext {
    const ctx = useContext(Context);
    if (!ctx) throw new Error('useSearchPalette must be used inside <SearchProvider>');
    return ctx;
}

/**
 * Where a keypress should be left alone: the user is typing into something,
 * or is inside a Headless UI menu / listbox / dialog that owns its own keys.
 */
function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return target.closest('[role="menu"], [role="menuitem"], [role="listbox"], [role="dialog"]') !== null;
}

/**
 * One palette for the whole app, mounted once, opened from anywhere:
 * `⌘K` / `Ctrl+K` toggles it, `/` opens it unless focus is in something that
 * takes text, and the triggers (sidebar, mobile bar) call `open`.
 * Opening from `/` swallows the slash so it never lands in the input.
 */
export function SearchProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [initialQuery, setInitialQuery] = useState('');
    const [source, setSource] = useState<SearchSource>('shortcut');
    /* Counts openings; it keys the palette, so each opening mounts a fresh one
       whose state starts from what it was opened with — a character a trigger
       forwarded, or nothing — instead of resetting the last opening's state. */
    const [opening, setOpening] = useState(0);

    const open = useCallback((query = '', from: SearchSource = 'shortcut') => {
        setInitialQuery(query);
        setSource(from);
        setIsOpen(true);
        setOpening((n) => n + 1);
        // No-op without a PostHog key (local dev). Never the query text.
        capture('search_opened', { source: from });
    }, []);
    const close = useCallback(() => setIsOpen(false), []);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (isOpen) close();
                else open('', 'shortcut');
                return;
            }
            // `defaultPrevented`: a trigger that forwards printable keys has
            // already opened with the character.
            if (
                e.key === '/' &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !isOpen &&
                !e.defaultPrevented &&
                !isEditableTarget(e.target)
            ) {
                e.preventDefault();
                open('', 'shortcut');
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [isOpen, open, close]);

    const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

    return (
        <Context.Provider value={value}>
            {children}
            <SearchPalette key={opening} isOpen={isOpen} initialQuery={initialQuery} source={source} onClose={close} />
        </Context.Provider>
    );
}
