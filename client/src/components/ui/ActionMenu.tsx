'use client'

import type { ComponentProps } from 'react'

/**
 * Shared pieces of a Primer ActionMenu built on Headless UI's `Menu`. The
 * sidebar's organization menu, user menu and help menu all render the same
 * floating panel and the same 16px-leading-visual items, so the class strings
 * live here rather than being retyped per menu. See docs/primer-audit/T8.
 */

/** The floating panel: raised surface, hairline border, floating shadow, 4px inset. */
export const MENU_PANEL_CLASS =
    'rounded-md bg-surface-raised border border-edge p-1 shadow-floating transition focus:outline-none ' +
    'data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in'

/**
 * Primer ActionList item: 16px `--fgColor-muted` leading visual, label at
 * `--fgColor-default`.
 */
export const MENU_ITEM_CLASS =
    'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink data-focus:bg-surface-hover cursor-pointer'

/** Primer ActionList.GroupHeading, the same shape as the sidebar's NavGroupHeading. */
export const MENU_HEADING_CLASS = 'mb-1 px-2 text-xs font-semibold text-ink-muted'

export const MENU_SEPARATOR_CLASS = 'my-1 h-px bg-edge'

/**
 * A single-select ActionMenu item. Headless UI's `MenuItem` hard-codes
 * `role="menuitem"` and merges its own props *over* the ones you pass, so the
 * role cannot be overridden from the outside — `as={…}` is the only seam that
 * lets the rendered element have the last word. Going through `MenuItem` (rather
 * than dropping a loose `<button>` into the panel) is what keeps the option
 * inside the menu's roving-focus contract.
 */
export function MenuRadioItem({ checked, ...props }: ComponentProps<'button'> & { checked: boolean }) {
    return <button {...props} type="button" role="menuitemradio" aria-checked={checked} />
}

/** The multi-select counterpart: options that combine, each ticked on its own. */
export function MenuCheckboxItem({ checked, ...props }: ComponentProps<'button'> & { checked: boolean }) {
    return <button {...props} type="button" role="menuitemcheckbox" aria-checked={checked} />
}
