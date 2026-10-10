'use client'

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'sr-theme'
const CHANGE_EVENT = 'sr-theme-change'

interface ThemeContextValue {
    theme: ThemePreference
    resolvedTheme: ResolvedTheme
    setTheme: (theme: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue>({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: () => {},
})

function readPreference(): ThemePreference {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY)
        if (stored === 'light' || stored === 'dark') return stored
    } catch {}
    return 'system'
}

function resolve(preference: ThemePreference): ResolvedTheme {
    if (preference === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return preference
}

// The preference lives in localStorage and the OS color scheme in matchMedia;
// subscribe to both (plus a local event for same-tab writes) so React state
// always mirrors them.
function subscribe(onChange: () => void) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', onChange)
    window.addEventListener('storage', onChange)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => {
        mq.removeEventListener('change', onChange)
        window.removeEventListener('storage', onChange)
        window.removeEventListener(CHANGE_EVENT, onChange)
    }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const theme = useSyncExternalStore(subscribe, readPreference, () => 'system' as const)
    const resolvedTheme = useSyncExternalStore(
        subscribe,
        () => resolve(readPreference()),
        () => 'light' as const,
    )

    // The inline script in layout.tsx applies the attribute pre-hydration;
    // this keeps it in sync afterwards (toggle clicks, OS changes, other tabs).
    useEffect(() => {
        document.documentElement.dataset.theme = resolvedTheme
    }, [resolvedTheme])

    const setTheme = useCallback((preference: ThemePreference) => {
        try {
            if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
            else localStorage.setItem(THEME_STORAGE_KEY, preference)
        } catch {}
        window.dispatchEvent(new Event(CHANGE_EVENT))
    }, [])

    return (
        <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    return useContext(ThemeContext)
}
