'use client';

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sr-theme';
const CHANGE_EVENT = 'sr-theme-change';

/**
 * What a visitor gets before they have chosen anything: dark, to match the
 * landing page. "System" is an explicit, stored choice, not the fallback, so a
 * light-OS visitor lands on the same dark dashboard the marketing site showed.
 * Must stay in sync with the pre-hydration script in app/layout.tsx.
 */
export const DEFAULT_THEME: ResolvedTheme = 'dark';

interface ThemeContextValue {
    theme: ThemePreference;
    resolvedTheme: ResolvedTheme;
    setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    theme: DEFAULT_THEME,
    resolvedTheme: DEFAULT_THEME,
    setTheme: () => {},
});

function readPreference(): ThemePreference {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {}
    return DEFAULT_THEME;
}

function resolve(preference: ThemePreference): ResolvedTheme {
    if (preference === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return preference;
}

// The preference lives in localStorage and the OS color scheme in matchMedia;
// subscribe to both (plus a local event for same-tab writes) so React state
// always mirrors them.
function subscribe(onChange: () => void) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onChange);
    window.addEventListener('storage', onChange);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
        mq.removeEventListener('change', onChange);
        window.removeEventListener('storage', onChange);
        window.removeEventListener(CHANGE_EVENT, onChange);
    };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const theme = useSyncExternalStore(subscribe, readPreference, () => DEFAULT_THEME);
    const resolvedTheme = useSyncExternalStore(
        subscribe,
        () => resolve(readPreference()),
        () => DEFAULT_THEME,
    );

    // The inline script in layout.tsx applies the attribute pre-hydration;
    // this keeps it in sync afterwards (toggle clicks, OS changes, other tabs).
    useEffect(() => {
        document.documentElement.dataset.theme = resolvedTheme;
    }, [resolvedTheme]);

    const setTheme = useCallback((preference: ThemePreference) => {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, preference);
        } catch {}
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }, []);

    return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
    return useContext(ThemeContext);
}
