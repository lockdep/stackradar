'use client';

import { useCallback, useMemo, type MouseEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Menu, MenuButton, MenuHeading, MenuItem, MenuItems, MenuSection } from '@headlessui/react';
import { Check, ChevronDown, ShieldAlert } from 'lucide-react';
import { severityDotClass, type SeverityKey } from '@/components/ui';
import { buttonClasses } from '@/components/ui/Button';
import { MENU_HEADING_CLASS, MENU_ITEM_CLASS, MENU_PANEL_CLASS, MenuCheckboxItem } from '@/components/ui/ActionMenu';
import { UNSCORED_HIDDEN_HINT, UNSCORED_LABEL } from '@/lib/severity';

export const SEVERITIES: SeverityKey[] = ['critical', 'high', 'medium', 'low'];

/**
 * The filter's vocabulary: the four bands plus `unscored` — findings whose
 * source published no severity. A fifth option rather than a fifth band, so
 * the severity cards, sparklines and counts elsewhere stay four-valued.
 */
export type SeverityFilterKey = SeverityKey | 'unscored';
export const SEVERITY_FILTER_KEYS: SeverityFilterKey[] = [...SEVERITIES, 'unscored'];

const SEVERITY_LABEL: Record<SeverityFilterKey, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    unscored: UNSCORED_LABEL,
};

/**
 * The severity filter, held in the URL rather than in React state — the same
 * bargain `useContainersView` makes: a filtered view is a link people paste,
 * and the Overview's severity cards deep-link here as
 * `?severity=critical`. A hand-edited or stale value degrades to "not
 * filtered" rather than throwing; defaults are absent from the query string.
 */
export function useSeverityFilter() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const param = searchParams.get('severity');
    const filters = useMemo(
        () =>
            new Set(
                (param ?? '')
                    .split(',')
                    .filter((s): s is SeverityFilterKey => (SEVERITY_FILTER_KEYS as string[]).includes(s)),
            ),
        [param],
    );

    /* `replace`, not `push`: ticking a severity refines one view, not navigates
       to another. */
    const write = useCallback(
        (next: Set<SeverityFilterKey>) => {
            const params = new URLSearchParams(searchParams.toString());
            // Written in declaration order rather than click order, so the
            // same view is always the same link.
            const value = SEVERITY_FILTER_KEYS.filter((s) => next.has(s)).join(',');
            if (value) params.set('severity', value);
            else params.delete('severity');
            const query = params.toString();
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    const toggle = useCallback(
        (severity: SeverityFilterKey) => {
            const next = new Set(filters);
            if (next.has(severity)) next.delete(severity);
            else next.add(severity);
            write(next);
        },
        [filters, write],
    );

    return { filters, toggle };
}

/** What the closed button reads: the selection itself while it is short, a count after. */
function summary(filters: Set<SeverityFilterKey>): string {
    const chosen = SEVERITY_FILTER_KEYS.filter((s) => filters.has(s));
    if (chosen.length === 0) return 'All severities';
    if (chosen.length <= 2) return chosen.map((s) => SEVERITY_LABEL[s]).join(', ');
    return `${chosen.length} severities`;
}

/**
 * The menu `useSeverityFilter` drives — `FilterMenu`'s button and panel with
 * a checkbox per severity band, since the bands combine: none ticked means no
 * filter. Ticking keeps the menu open, so "critical and high" is one visit.
 *
 * "Unscored" is a fifth row carrying its count when the list has any. The
 * count makes the category visible: an unscored row renders no severity, so
 * without it nothing on the page says how many findings the four bands
 * leave out.
 */
export function SeverityFilterMenu({
    filters,
    onToggle,
    unscoredCount = 0,
}: {
    filters: Set<SeverityFilterKey>;
    onToggle: (severity: SeverityFilterKey) => void;
    /** Unscored findings in scope (under the search alone); the row hides at 0 unless ticked. */
    unscoredCount?: number;
}) {
    const narrowed = filters.size > 0;
    const keys = SEVERITY_FILTER_KEYS.filter((s) => s !== 'unscored' || unscoredCount > 0 || filters.has('unscored'));
    return (
        <Menu>
            <MenuButton
                aria-label={`Severity: ${summary(filters)}`}
                className={buttonClasses({
                    variant: narrowed ? 'selected' : 'secondary',
                    className:
                        'focus:outline-none data-focus:outline-2 data-focus:outline-offset-2 data-focus:outline-accent',
                })}
            >
                <ShieldAlert aria-hidden className={`size-4 shrink-0 ${narrowed ? 'text-accent' : 'text-ink-muted'}`} />
                <span className="truncate">{summary(filters)}</span>
                <ChevronDown
                    aria-hidden
                    className={`-mr-1 size-4 shrink-0 ${narrowed ? 'text-accent' : 'text-ink-muted'}`}
                />
            </MenuButton>
            <MenuItems transition anchor="bottom start" className={`z-50 w-56 [--anchor-gap:4px] ${MENU_PANEL_CLASS}`}>
                <MenuSection>
                    <MenuHeading as="p" className={`${MENU_HEADING_CLASS} pt-1.5`}>
                        Severity
                    </MenuHeading>
                    {keys.map((severity) => {
                        const checked = filters.has(severity);
                        return (
                            <MenuItem
                                key={severity}
                                as={MenuCheckboxItem}
                                checked={checked}
                                title={severity === 'unscored' ? UNSCORED_HIDDEN_HINT : undefined}
                                onClick={(event: MouseEvent) => {
                                    // Headless closes the menu on an item click unless it is prevented.
                                    event.preventDefault();
                                    onToggle(severity);
                                }}
                                className={MENU_ITEM_CLASS}
                            >
                                <span
                                    aria-hidden
                                    className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                                        checked
                                            ? 'border-accent-emphasis bg-accent-emphasis text-white'
                                            : 'border-edge-strong'
                                    }`}
                                >
                                    {checked && <Check className="size-3" strokeWidth={3} />}
                                </span>
                                <span
                                    aria-hidden
                                    className={`inline-block size-2 shrink-0 rounded-full ${
                                        severity === 'unscored'
                                            ? 'border border-dashed border-edge-strong'
                                            : severityDotClass[severity]
                                    }`}
                                />
                                <span className="min-w-0 flex-1 text-left">{SEVERITY_LABEL[severity]}</span>
                                {severity === 'unscored' && (
                                    <span className="text-xs tabular-nums text-ink-muted">
                                        {unscoredCount.toLocaleString()}
                                    </span>
                                )}
                            </MenuItem>
                        );
                    })}
                </MenuSection>
            </MenuItems>
        </Menu>
    );
}
