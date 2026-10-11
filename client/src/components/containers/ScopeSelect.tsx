'use client';

import { ChevronDown } from 'lucide-react';

/**
 * A scope picker: a native `<select>` dressed as a secondary button, with the
 * chevron drawn by us because `appearance-none` removes the browser's.
 *
 * The Feed's cluster scope, beside `DaysFilter` — the same markup with its
 * options baked in — so the two read as one family.
 *
 * The "all" option is always first and always rendered, even with one real
 * option: a closed select shows one value on its own, and "All clusters" is
 * what tells the reader the scope they are looking at.
 *
 * A chosen option is a filter in force, and is drawn as the filter menus draw
 * one (`Button`'s `selected` variant): tinted fill, accent border and text.
 */
export function ScopeSelect({
    label,
    value,
    onChange,
    allLabel,
    options,
}: {
    /** The accessible name — "Scope to cluster". */
    label: string;
    /** The selected option's value, or null for the "all" option. */
    value: string | null;
    onChange: (value: string | null) => void;
    /** The first option's text — "All clusters". */
    allLabel: string;
    options: { value: string; label: string }[];
}) {
    const narrowed = value !== null;
    return (
        <span className="relative inline-block">
            <select
                aria-label={label}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value || null)}
                className={`h-8 max-w-56 appearance-none truncate rounded-md border pr-8 pl-3 text-sm cursor-pointer ${
                    narrowed
                        ? 'border-accent-emphasis bg-accent-subtle font-medium text-accent hover:bg-accent-muted'
                        : 'border-edge bg-btn-secondary text-ink hover:bg-btn-secondary-hover'
                }`}
            >
                <option value="">{allLabel}</option>
                {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>
            <ChevronDown
                aria-hidden
                className={`pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 ${narrowed ? 'text-accent' : 'text-ink-muted'}`}
            />
        </span>
    );
}
