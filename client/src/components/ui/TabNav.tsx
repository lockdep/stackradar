'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType } from 'react'
import {
    underlineNavStripClasses,
    underlineNavListClasses,
    underlineNavItemClasses,
    UnderlineNavItemContent,
} from './underlineNav'

export interface TabNavItem {
    /** Absolute path. Matched against `usePathname()` exactly. */
    href: string
    name: string
    icon?: ComponentType<{ className?: string }>
}

interface TabNavProps {
    items: TabNavItem[]
    /** Names the strip for screen readers. */
    label: string
}

/**
 * Primer UnderlineNav, in its navigation form — use this when the tabs change
 * the URL. For tabs that swap in-page content, use `TabBar`/`TabPanel` instead:
 * that one owns the `role="tab"` contract, and these links must not claim it.
 *
 * Concretely, the differences from `TabBar` are all consequences of "these are
 * links": no `role="tablist"`/`role="tab"`, no `aria-controls`, no owning
 * panel, and no roving `tabIndex` or arrow-key handler — each link is
 * individually tabbable, which is what a nav is supposed to do. The current
 * item is marked with `aria-current="page"`, and the selected styling hangs off
 * that attribute rather than off a prop.
 *
 * Visually identical to `TabBar`; both pull from `underlineNav.tsx`.
 */
export function TabNav({ items, label }: TabNavProps) {
    const pathname = usePathname()

    return (
        <div className={underlineNavStripClasses}>
            <nav aria-label={label} className={underlineNavListClasses}>
                {items.map(item => (
                    <Link
                        key={item.href}
                        href={item.href}
                        aria-current={pathname === item.href ? 'page' : undefined}
                        className={`group ${underlineNavItemClasses} aria-[current=page]:after:bg-border-active`}
                    >
                        <UnderlineNavItemContent
                            icon={item.icon}
                            name={item.name}
                            labelClassName="group-aria-[current=page]:font-semibold"
                        />
                    </Link>
                ))}
            </nav>
        </div>
    )
}
