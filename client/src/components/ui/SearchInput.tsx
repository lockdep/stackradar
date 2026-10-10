'use client'

import { useRef } from 'react'
import { Search } from 'lucide-react'

type Props = {
    /** Also the input's `name`, and what the sr-only label points at. */
    id: string
    /** Screen-reader label — say what the box searches. */
    label: string
    placeholder: string
    value: string
    onChange: (value: string) => void
    /** The wrapper's box — its own line by default; a toolbar passes a width and no margin. */
    className?: string
}

/**
 * The server-search box of the cluster Packages and Vulnerabilities tabs and
 * the org-wide lists: a page filter. Escape blurs it. `/` is not its key —
 * `/` and ⌘K open the global search palette from every page
 * (`components/search`), and a second meaning for the same key on some
 * pages is what this box used to have. Pair it with `usePagedResource`,
 * which owns the debounce.
 */
export function SearchInput({ id, label, placeholder, value, onChange, className = 'mb-3 w-full max-w-xs' }: Props) {
    const inputRef = useRef<HTMLInputElement>(null)

    return (
        <div className={className}>
            <label htmlFor={id} className="sr-only">
                {label}
            </label>
            <div className="relative">
                <Search
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-faint"
                    aria-hidden="true"
                />
                <input
                    ref={inputRef}
                    type="text"
                    id={id}
                    name={id}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Escape') {
                            inputRef.current?.blur()
                        }
                    }}
                    className="block w-full rounded-md border border-edge-strong focus:border-edge-strong py-1 pl-9 pr-3 text-ink ring-0 ring-edge-strong placeholder:text-ink-faint focus:ring-4 outline-none focus:ring-edge sm:text-xs sm:leading-6"
                    placeholder={placeholder}
                    autoComplete="off"
                />
            </div>
        </div>
    )
}
