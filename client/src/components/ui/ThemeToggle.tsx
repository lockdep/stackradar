'use client';

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemePreference } from '@/components/providers';

/**
 * The three theme choices, in the order they are presented. Shared with the
 * theme group in the sidebar's `UserMenu` so the two surfaces cannot drift.
 */
export const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle({ showLabels = false, className = '' }: { showLabels?: boolean; className?: string }) {
    const { theme, setTheme } = useTheme();

    return (
        <div
            role="radiogroup"
            aria-label="Theme"
            className={`inline-flex items-center gap-0.5 rounded-md border border-edge bg-surface-muted p-0.5 ${className}`}
        >
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = theme === value;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={label}
                        onClick={() => setTheme(value)}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                            active
                                ? 'bg-surface-hover text-nav-active-fg shadow-resting'
                                : 'text-ink-faint hover:text-ink-secondary'
                        }`}
                    >
                        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                        {showLabels && label}
                        {!showLabels && <span className="sr-only">{label}</span>}
                    </button>
                );
            })}
        </div>
    );
}
