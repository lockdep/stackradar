import { ChevronUp, ChevronDown } from 'lucide-react'

type SortIconProps<T extends string> = {
    column: T
    sortColumn: T | null
    sortDirection: 'asc' | 'desc'
    /** Which side of the label the icon sits on, so the gap falls between the two. */
    position?: 'leading' | 'trailing'
}

/**
 * `aria-sort` value for the `<th>` wrapping a sortable column.
 * Only the currently sorted column reports a direction; the rest report "none".
 */
export function ariaSort<T extends string>(
    column: T,
    sortColumn: T | null,
    sortDirection: 'asc' | 'desc',
): 'ascending' | 'descending' | 'none' {
    if (sortColumn !== column) return 'none'
    return sortDirection === 'asc' ? 'ascending' : 'descending'
}

export function SortIcon<T extends string>({ column, sortColumn, sortDirection, position = 'leading' }: SortIconProps<T>) {
    const gap = position === 'leading' ? 'mr-2' : 'ml-2'
    if (sortColumn !== column) {
        return (
            <span className={`${gap} flex-none rounded-sm text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity`}>
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </span>
        )
    }
    return (
        <span className={`${gap} flex-none rounded-sm bg-surface-hover text-ink`}>
            {sortDirection === 'asc' ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
        </span>
    )
}

