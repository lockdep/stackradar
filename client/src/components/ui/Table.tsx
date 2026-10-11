'use client';

import { createContext, useContext, useMemo } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { SortIcon, ariaSort } from './SortIcon';

/**
 * Primer's DataTable, in the shape this app actually needs.
 *
 * The API is compositional rather than data-driven on purpose: of the 21 tables
 * here, one is a tree, three have expandable nested rows, two have a
 * totals `<tfoot>` and one draws a timeline rail down its leading column. A
 * `columns`/`rows` component could hold none of them. What this owns instead is
 * every *styling* decision — density, header treatment, row hover, radius — so
 * a table can't drift into a new dialect.
 *
 * ```tsx
 * <TableContainer>
 *     <Table density="spacious" aria-label="Clusters">
 *         <TableHead>
 *             <TableHeader>Name</TableHeader>
 *             <TableHeader align="end">Containers</TableHeader>
 *             <TableHeader srOnly>Open</TableHeader>
 *         </TableHead>
 *         <TableBody>
 *             {rows.map(r => (
 *                 <TableRow key={r.id} onClick={() => select(r)}>
 *                     <TableCell>{r.name}</TableCell>
 *                     <TableCell align="end">{r.count}</TableCell>
 *                     <TableCell align="end"><ChevronRight … /></TableCell>
 *                 </TableRow>
 *             ))}
 *         </TableBody>
 *     </Table>
 * </TableContainer>
 * ```
 */

/**
 * Overriding cell padding via `className`: Tailwind resolves conflicts by the
 * order it *emits* the utilities, never by the order you write them. It emits
 * shorthand → axis → side, so `pl-0` and `pl-8` beat the base `px-3` while
 * **`px-0` silently loses to it**. Reach for the per-side utility.
 */
export type TableDensity = 'condensed' | 'normal' | 'spacious';

/* Horizontal padding is uniform, Primer-style — the container supplies the
   inset, not the leading and trailing cells. Only the vertical step changes.

   Phones get one step less on both axes: at 390px a 12px gutter on every cell
   of a five-column row is a fifth of the screen spent on nothing. */
const CELL_PADDING: Record<TableDensity, string> = {
    condensed: 'px-2 py-1 sm:px-3 sm:py-1.5',
    normal: 'px-2 py-2 sm:px-3 sm:py-2.5',
    spacious: 'px-2 py-2.5 sm:px-3 sm:py-3.5',
};

/**
 * Which viewport a column first appears at. `hideBelow="md"` on a header and
 * on the matching cell of every row (`TableEmpty` spans, so it needs nothing)
 * collapses the column on phones and brings it back from `md` up. Header and
 * cells must agree or the rows shift under the header.
 *
 * A static map, not a template string: Tailwind only emits classes it can
 * read verbatim from the source.
 */
export type TableBreakpoint = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';

const HIDE_BELOW: Record<TableBreakpoint, string> = {
    sm: 'hidden sm:table-cell',
    md: 'hidden md:table-cell',
    lg: 'hidden lg:table-cell',
    xl: 'hidden xl:table-cell',
    '2xl': 'hidden 2xl:table-cell',
    '3xl': 'hidden 3xl:table-cell',
};

export type TableAlign = 'start' | 'center' | 'end';

const ALIGN: Record<TableAlign, string> = {
    start: 'text-left',
    center: 'text-center',
    end: 'text-right',
};

const JUSTIFY: Record<TableAlign, string> = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
};

/**
 * Cell text size. `sm` is the default everywhere; `xs` is for a dense listing
 * whose rows are scanned rather than read — Primer's condensed DataTable runs
 * at 12px for the same reason. Headers are `text-xs` regardless.
 */
export type TableTextSize = 'sm' | 'xs';

/* `sm` steps down to 12px on phones, where a 14px cell wraps the moment a
   second column shows up. `xs` is already there. */
const TEXT_SIZE: Record<TableTextSize, string> = {
    sm: 'text-xs sm:text-sm',
    xs: 'text-xs',
};

const TableContext = createContext<{ density: TableDensity; textSize: TableTextSize }>({
    density: 'normal',
    textSize: 'sm',
});

function cx(...parts: (string | false | undefined)[]) {
    return parts.filter(Boolean).join(' ');
}

// ── Container ────────────────────────────────────────────────────────────────

/**
 * `card` — its own bordered, raised panel (a table that *is* the section).
 * `section` — full-bleed, hairlines top and bottom (a table inside a tab body).
 * `plain` — no chrome at all (a table already inside a padded card).
 */
export type TableContainerVariant = 'card' | 'section' | 'plain';

const CONTAINER: Record<TableContainerVariant, string> = {
    card: 'overflow-hidden border border-edge bg-surface-raised shadow-resting',
    section: 'overflow-hidden border-y border-edge bg-surface-raised',
    plain: '',
};

export interface TableContainerProps extends ComponentPropsWithoutRef<'div'> {
    variant?: TableContainerVariant;
    /**
     * Square corners on the `card` variant. A prop rather than a `rounded-none`
     * override in `className`, because both utilities set `border-radius` and
     * which one wins is decided by Tailwind's emission order, not by the caller.
     */
    square?: boolean;
}

export function TableContainer({
    variant = 'card',
    square = false,
    className = '',
    children,
    ...rest
}: TableContainerProps) {
    /* The scroller is a child, not the container itself: `overflow-x-auto` on a
       rounded, clipped box would defeat the corner clipping. */
    return (
        <div className={cx(CONTAINER[variant], variant === 'card' && !square && 'rounded-md', className)} {...rest}>
            <div className="overflow-x-auto">{children}</div>
        </div>
    );
}

// ── Table ────────────────────────────────────────────────────────────────────

export interface TableProps extends ComponentPropsWithoutRef<'table'> {
    density?: TableDensity;
    textSize?: TableTextSize;
}

export function Table({ density = 'normal', textSize = 'sm', className = '', children, ...rest }: TableProps) {
    const value = useMemo(() => ({ density, textSize }), [density, textSize]);
    return (
        <TableContext.Provider value={value}>
            <table className={cx('min-w-full', className)} {...rest}>
                {children}
            </table>
        </TableContext.Provider>
    );
}

// ── Sections ─────────────────────────────────────────────────────────────────

/**
 * Renders its own single `<tr>` — every header here is one row, and owning it
 * is what keeps the header treatment from being re-decided per table.
 *
 * `surface-hover`, not `surface-muted`: the latter is 1.00:1 against
 * `surface-raised` in dark. See the `ui-theming` skill.
 */
export interface TableHeadProps extends ComponentPropsWithoutRef<'thead'> {
    /**
     * The header fill. Turn it off for a nested table that already sits on a
     * tinted backdrop, where a second fill would read as a third surface.
     */
    filled?: boolean;
}

export function TableHead({ filled = true, className = '', children, ...rest }: TableHeadProps) {
    return (
        <thead className={cx('border-b border-edge', filled && 'bg-surface-hover', className)} {...rest}>
            <tr>{children}</tr>
        </thead>
    );
}

export interface TableBodyProps extends ComponentPropsWithoutRef<'tbody'> {
    /**
     * Rules between rows. Turn off only when a row draws its own — the SBOM
     * history table runs a timeline rail down its leading column, so its rule
     * has to skip that cell.
     */
    divided?: boolean;
}

export function TableBody({ divided = true, className = '', ...rest }: TableBodyProps) {
    return <tbody className={cx(divided && 'divide-y divide-edge', className)} {...rest} />;
}

/** Totals row. Like `TableHead`, it renders its own single `<tr>`. */
export function TableFoot({ className = '', children, ...rest }: ComponentPropsWithoutRef<'tfoot'>) {
    return (
        <tfoot className={cx('border-t-2 border-edge-strong bg-surface-hover', className)} {...rest}>
            <tr>{children}</tr>
        </tfoot>
    );
}

// ── Cells ────────────────────────────────────────────────────────────────────

/* `align` shadows the deprecated HTML attribute of the same name on every cell
   element, hence the Omit — ours is a Primer-style logical alignment. */
export interface TableHeaderProps extends Omit<ComponentPropsWithoutRef<'th'>, 'align'> {
    align?: TableAlign;
    /** Actions/chevron columns: keeps the column labelled without showing text. */
    srOnly?: boolean;
    /** Collapse the column below this breakpoint. Pair with the same value on the cells. */
    hideBelow?: TableBreakpoint;
}

/**
 * Sentence case, `ink-muted`, weight 600 — GitHub's table headers, not the
 * `uppercase tracking-wide` Tailwind-UI idiom this app had in seven files (T6-10).
 */
export function TableHeader({
    align = 'start',
    srOnly = false,
    hideBelow,
    className = '',
    children,
    ...rest
}: TableHeaderProps) {
    const { density } = useContext(TableContext);
    return (
        <th
            scope="col"
            className={cx(
                CELL_PADDING[density],
                ALIGN[align],
                'text-xs font-semibold whitespace-nowrap text-ink-muted',
                hideBelow && HIDE_BELOW[hideBelow],
                className,
            )}
            {...rest}
        >
            {srOnly ? <span className="sr-only">{children}</span> : children}
        </th>
    );
}

export interface SortableHeaderProps<T extends string> extends Omit<
    ComponentPropsWithoutRef<'th'>,
    'onClick' | 'align'
> {
    column: T;
    sortColumn: T | null;
    sortDirection: 'asc' | 'desc';
    onSort: (column: T) => void;
    align?: TableAlign;
    /** Collapse the column below this breakpoint. Pair with the same value on the cells. */
    hideBelow?: TableBreakpoint;
}

/**
 * A sortable column: a real `<button>` inside a `<th aria-sort>`, which is
 * Primer's contract and the only way the column is reachable without a pointer.
 *
 * The `<th>` gives up its padding to the button so the hover fill covers the
 * whole cell rather than a box floating inside it.
 */
export function SortableHeader<T extends string>({
    column,
    sortColumn,
    sortDirection,
    onSort,
    align = 'start',
    hideBelow,
    className = '',
    children,
    ...rest
}: SortableHeaderProps<T>) {
    const { density } = useContext(TableContext);
    return (
        <th
            scope="col"
            aria-sort={ariaSort(column, sortColumn, sortDirection)}
            className={cx(
                'p-0 text-xs font-semibold whitespace-nowrap text-ink-muted',
                ALIGN[align],
                hideBelow && HIDE_BELOW[hideBelow],
                className,
            )}
            {...rest}
        >
            <button
                type="button"
                onClick={() => onSort(column)}
                className={cx(
                    CELL_PADDING[density],
                    JUSTIFY[align],
                    /* `btn-secondary-hover`, not `surface-hover` — the header row
                       is already `surface-hover`, so it needs the step above it. */
                    'group flex w-full cursor-pointer items-center select-none transition-colors',
                    'hover:bg-btn-secondary-hover',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-emphasis',
                )}
            >
                {/* Primer DataTable's rule: the chevron trails the label on a
                    start-aligned column, where it reads as the label's state,
                    and leads it on an `align="end"` column — there a trailing
                    chevron sits between the label and the numbers below it,
                    so the label never lines up with its own column. Either
                    way the label stays flush with its values. */}
                {align === 'end' && (
                    <SortIcon
                        column={column}
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        position="leading"
                    />
                )}
                {children}
                {align !== 'end' && (
                    <SortIcon
                        column={column}
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        position="trailing"
                    />
                )}
            </button>
        </th>
    );
}

export interface TableRowProps extends ComponentPropsWithoutRef<'tr'> {
    /** Hover + focus-within fill. Implied by `onClick`. */
    hoverable?: boolean;
    /** Expanded or current row — an accent fill that stands in for the hover fill. */
    selected?: boolean;
}

/**
 * A row with `onClick` is a control, so it is one by keyboard too: in the
 * Tab order, Enter and Space fire the click, and the focus ring is the one
 * every button here draws. Sixteen callers hand a `<tr>` an `onClick` for
 * expand/collapse and even navigation (the admin lists, the cluster list),
 * and until this none of those rows could be reached without a pointer.
 *
 * The role: `button` for a plain click row, so a screen reader announces
 * the row's text as something pressable. A caller that passes
 * `aria-expanded` is a disclosure and keeps the row role — `aria-expanded`
 * is valid on `row`, and a `button` role would drop its cells from the
 * table. Rows whose cell already carries a chevron `<button>` give that
 * button `tabIndex={-1}` so the row is the one tab stop, rather than two
 * stops for one action.
 *
 * The key handler fires only when the row itself is the target: a nested
 * link or button handles its own Enter, and its bubbled keydown must not
 * toggle the row underneath it. `click()` rather than calling `onClick`
 * with a cast keyboard event, so the caller's `stopPropagation` contract
 * and React's synthetic click are the same path as a pointer.
 */
export function TableRow({
    hoverable,
    selected = false,
    className = '',
    onClick,
    onKeyDown,
    tabIndex,
    role,
    ...rest
}: TableRowProps) {
    const interactive = hoverable ?? Boolean(onClick);
    const expands = rest['aria-expanded'] !== undefined;
    return (
        <tr
            onClick={onClick}
            tabIndex={onClick ? (tabIndex ?? 0) : tabIndex}
            role={onClick && !expands ? (role ?? 'button') : role}
            onKeyDown={
                onClick
                    ? (e) => {
                          onKeyDown?.(e);
                          if (e.defaultPrevented || e.target !== e.currentTarget) return;
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.currentTarget.click();
                      }
                    : onKeyDown
            }
            className={cx(
                selected ? 'bg-accent-subtle' : interactive && 'hover:bg-surface-hover focus-within:bg-surface-hover',
                onClick &&
                    'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-emphasis',
                className,
            )}
            {...rest}
        />
    );
}

export interface TableCellProps extends Omit<ComponentPropsWithoutRef<'td'>, 'align'> {
    align?: TableAlign;
    /** Collapse the cell below this breakpoint. Pair with the same value on the header. */
    hideBelow?: TableBreakpoint;
}

export function TableCell({ align = 'start', hideBelow, className = '', ...rest }: TableCellProps) {
    const { density, textSize } = useContext(TableContext);
    return (
        <td
            className={cx(
                CELL_PADDING[density],
                ALIGN[align],
                TEXT_SIZE[textSize],
                hideBelow && HIDE_BELOW[hideBelow],
                className,
            )}
            {...rest}
        />
    );
}

// ── Empty state ──────────────────────────────────────────────────────────────

/**
 * Stands in for `<TableBody>` when there is nothing to show, so the header row
 * and the container survive and the table doesn't collapse to a bare sentence.
 */
export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
    return (
        <tbody>
            <tr>
                <td colSpan={colSpan} className="px-3 py-8 text-center text-xs text-ink-muted sm:text-sm">
                    {children}
                </td>
            </tr>
        </tbody>
    );
}
