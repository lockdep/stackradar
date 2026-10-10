'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Menu, MenuButton, MenuHeading, MenuItem, MenuItems, MenuSection, MenuSeparator } from '@headlessui/react'
import { Check, ChevronDown } from 'lucide-react'
import { buttonClasses } from './Button'
import { MENU_HEADING_CLASS, MENU_ITEM_CLASS, MENU_PANEL_CLASS, MENU_SEPARATOR_CLASS, MenuRadioItem } from './ActionMenu'

export interface FilterMenuOption<T extends string | number> {
    value: T
    label: string
    /** One muted line under the label: what choosing it leaves in. */
    description?: string | undefined
    /** How many rows the option leaves in, beside its label. */
    count?: number | undefined
}

/**
 * One filter of a toolbar, as Primer's single-select ActionMenu: a secondary
 * button that always reads as its current value, opening a short list with a
 * check on the selected row.
 *
 * The button shows the *value*, never the filter's name — "Third-party
 * images", not "Images" — so a row of these reads as a sentence about what is
 * on screen, and a closed menu never hides a narrowed view. The name is the
 * menu's heading and the button's accessible label.
 *
 * A menu rather than a native `<select>` (`ScopeSelect`, `DaysFilter`): the
 * options here need a line of explanation each, which an `<option>` cannot
 * carry.
 */
export function FilterMenu<T extends string | number>({
    label,
    icon,
    value,
    options,
    onChange,
    narrowed = false,
    align = 'start',
    footerLink,
}: {
    /** The filter's name — the menu heading, and the button's accessible label with the value. */
    label: string
    /** 16px leading visual. */
    icon?: ReactNode
    value: T
    options: readonly FilterMenuOption<T>[]
    onChange: (value: T) => void
    /** The value hides something: the button says so — the `selected` variant, filled and in the accent colour. */
    narrowed?: boolean
    /** Which edge of the button the panel hangs from. */
    align?: 'start' | 'end'
    /** A last item under a separator: where what the options mean is managed. */
    footerLink?: { href: string; label: string; icon?: ReactNode } | undefined
}) {
    const selected = options.find(option => option.value === value)
    return (
        <Menu>
            <MenuButton
                aria-label={`${label}: ${selected?.label ?? ''}`}
                className={buttonClasses({
                    variant: narrowed ? 'selected' : 'secondary',
                    className: 'focus:outline-none data-focus:outline-2 data-focus:outline-offset-2 data-focus:outline-accent',
                })}
            >
                {icon && (
                    <span aria-hidden className={`shrink-0 [&>svg]:size-4 ${narrowed ? 'text-accent' : 'text-ink-muted'}`}>
                        {icon}
                    </span>
                )}
                <span className="truncate">{selected?.label}</span>
                <ChevronDown aria-hidden className={`-mr-1 size-4 shrink-0 ${narrowed ? 'text-accent' : 'text-ink-muted'}`} />
            </MenuButton>
            {/* Capped and scrolling (Headless UI reads the variable): a
                namespace menu is as long as the cluster is, and a list of
                names to scroll is still simpler than a combobox. */}
            <MenuItems
                transition
                anchor={align === 'end' ? 'bottom end' : 'bottom start'}
                className={`z-50 w-72 [--anchor-gap:4px] [--anchor-max-height:26rem] ${MENU_PANEL_CLASS}`}
            >
                <MenuSection>
                    <MenuHeading as="p" className={`${MENU_HEADING_CLASS} pt-1.5`}>
                        {label}
                    </MenuHeading>
                    {options.map(option => {
                        const isSelected = option.value === value
                        return (
                            <MenuItem
                                key={option.value}
                                as={MenuRadioItem}
                                checked={isSelected}
                                onClick={() => onChange(option.value)}
                                className={`${MENU_ITEM_CLASS} items-start`}
                            >
                                <span className="min-w-0 flex-1 text-left">
                                    <span className={`block ${isSelected ? 'font-semibold' : ''}`}>{option.label}</span>
                                    {option.description && (
                                        <span className="block text-xs text-ink-muted">{option.description}</span>
                                    )}
                                </span>
                                {option.count !== undefined && (
                                    <span className="mt-0.5 shrink-0 text-xs tabular-nums text-ink-muted">
                                        {option.count.toLocaleString()}
                                    </span>
                                )}
                                {/* The slot is kept when empty so labels do not shift between rows. */}
                                <span className="mt-0.5 size-4 shrink-0">
                                    {isSelected && <Check aria-hidden className="size-4 text-ink-muted" />}
                                </span>
                            </MenuItem>
                        )
                    })}
                </MenuSection>
                {footerLink && (
                    <>
                        <MenuSeparator className={MENU_SEPARATOR_CLASS} />
                        <MenuItem>
                            <Link href={footerLink.href} className={MENU_ITEM_CLASS}>
                                {footerLink.icon && (
                                    <span aria-hidden className="shrink-0 text-ink-muted [&>svg]:size-4">
                                        {footerLink.icon}
                                    </span>
                                )}
                                {footerLink.label}
                            </Link>
                        </MenuItem>
                    </>
                )}
            </MenuItems>
        </Menu>
    )
}
