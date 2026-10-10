'use client'

import { useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import {
    underlineNavStripClasses,
    underlineNavListClasses,
    underlineNavItemClasses,
    underlineNavItemActiveClasses,
    UnderlineNavItemContent,
} from './underlineNav'

export interface TabBarItem {
    id: string
    name: string
    icon?: ComponentType<{ className?: string }>
    /** Primer's counter slot. Omitted (not zero) until the number is known. */
    count?: number
}

interface TabBarProps {
    tabs: TabBarItem[]
    activeTab: string
    onChange: (id: string) => void
    /** Names the tab strip for screen readers. Required when a page has more than one. */
    label?: string
}

const tabId = (id: string) => `tab-${id}`
const panelId = (id: string) => `tabpanel-${id}`

/**
 * Primer UnderlineNav, in its tab (UnderlinePanels) form — use this when the
 * tabs swap in-page content. When the tabs change the URL, use `TabNav`: these
 * buttons own the `role="tab"` contract and a set of links must not claim it.
 *
 * Selection is carried by a semibold label *and* the coral underline — never by
 * colour alone, because `border-active` is only 2.15:1 on the light canvas. The
 * label colour deliberately does not change: in Primer a blue label means link.
 */
export function TabBar({ tabs, activeTab, onChange, label }: TabBarProps) {
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

    // Arrow keys move between tabs; the tab strip itself is one tab stop.
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        const index = offset !== 0
            ? (tabs.findIndex(t => t.id === activeTab) + offset + tabs.length) % tabs.length
            : event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
            : -1

        if (index === -1) return
        event.preventDefault()
        const next = tabs[index]
        onChange(next.id)
        tabRefs.current[next.id]?.focus()
    }

    return (
        <div className={underlineNavStripClasses}>
            <nav
                role="tablist"
                aria-label={label}
                className={underlineNavListClasses}
            >
                {tabs.map(tab => {
                    const selected = activeTab === tab.id
                    return (
                        <button
                            key={tab.id}
                            ref={el => { tabRefs.current[tab.id] = el }}
                            id={tabId(tab.id)}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-controls={panelId(tab.id)}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => onChange(tab.id)}
                            onKeyDown={handleKeyDown}
                            className={`${underlineNavItemClasses} ${
                                selected ? underlineNavItemActiveClasses : ''
                            }`}
                        >
                            <UnderlineNavItemContent
                                icon={tab.icon}
                                name={tab.name}
                                labelClassName={selected ? 'font-semibold' : ''}
                            >
                                {/* Primer's Counter: a translucent neutral, so it stays a
                                    step darker than whatever is under it — the hover pill
                                    included. An opaque surface token went lighter than the
                                    hover fill and read as a hole. */}
                                {tab.count !== undefined && (
                                    <span className="rounded-full bg-neutral-subtle px-1.5 text-xs font-medium tabular-nums text-ink">
                                        {tab.count}
                                    </span>
                                )}
                            </UnderlineNavItemContent>
                        </button>
                    )
                })}
            </nav>
        </div>
    )
}

interface TabPanelProps {
    /** Must match the `TabBarItem.id` of the tab that controls this panel. */
    tabId: string
    active: boolean
    children: ReactNode
}

/** The `role="tabpanel"` half of the contract — without it the tabs announce as broken. */
export function TabPanel({ tabId: id, active, children }: TabPanelProps) {
    if (!active) return null
    return (
        <div id={panelId(id)} role="tabpanel" aria-labelledby={tabId(id)} tabIndex={0}>
            {children}
        </div>
    )
}
