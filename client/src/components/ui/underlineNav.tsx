import type { ComponentType, ReactNode } from 'react';

/**
 * Primer UnderlineNav item styling, shared by the two components that wear it:
 *
 * - `TabBar` — Primer's UnderlinePanels. `role="tab"` buttons that swap an
 *   in-page `TabPanel`.
 * - `TabNav` — Primer's UnderlineNav. A `<nav>` of links that change the URL.
 *
 * Every value here is lifted from Primer's `UnderlineTabbedInterface.module.css`.
 * They live in one place so the two components cannot drift apart visually —
 * which is the whole point of splitting them on behaviour rather than looks.
 *
 * The *selected* state is deliberately not in here. The two express it
 * differently: `TabBar` from a React prop, `TabNav` from the `aria-current`
 * attribute it has to set anyway.
 */

/** The strip's container — bottom rule that the active bar sits on. */
export const underlineNavStripClasses = 'mb-6 border-b border-edge';

/** The row of items inside the strip. */
export const underlineNavListClasses = 'flex items-center gap-2 overflow-x-auto pt-2 [scrollbar-width:none]';

/**
 * One item, in its unselected state: 32px tall, 8px padding-inline, 6px radius,
 * neutral hover pill, inset accent focus ring, and an empty 2px `::after` bar
 * parked on the container's border. Selected state colours that bar in with
 * {@link underlineNavItemActiveClasses}.
 */
export const underlineNavItemClasses =
    "relative mb-2 inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-ink transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset after:absolute after:inset-x-0 after:bottom-0 after:-mb-2 after:h-0.5 after:content-['']";

/**
 * The coral underline. Only ever paired with a semibold label — coral is 2.15:1
 * on the light canvas, so it cannot carry the selected state alone.
 */
export const underlineNavItemActiveClasses = 'after:bg-border-active';

interface UnderlineNavItemContentProps {
    icon?: ComponentType<{ className?: string }>;
    name: string;
    /**
     * How this item goes semibold when current — `'font-semibold'` for a
     * prop-driven strip, a `group-aria-[current=page]:` variant for a nav.
     */
    labelClassName?: string;
    /** Rendered after the label. Primer's counter slot. */
    children?: ReactNode;
}

/**
 * Icon + label. The label carries an invisible bold copy of itself so going
 * semibold doesn't shift the items after it.
 */
export function UnderlineNavItemContent({
    icon: Icon,
    name,
    labelClassName = '',
    children,
}: UnderlineNavItemContentProps) {
    return (
        <>
            {Icon && <Icon className="size-4 shrink-0 text-ink-muted" />}
            <span
                data-content={name}
                className={`before:invisible before:block before:h-0 before:font-semibold before:whitespace-nowrap before:content-[attr(data-content)] ${labelClassName}`}
            >
                {name}
            </span>
            {children}
        </>
    );
}
