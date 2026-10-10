import { useRef } from 'react'
import { Search } from 'lucide-react'

/**
 * The admin org view's search box. The containers lists themselves use
 * `ContainersFilterBar`; the admin table has nothing else to filter by.
 *
 * A page filter, so `/` is not its key: `/` and ⌘K open the global search
 * palette from every page (`components/search`).
 */
export function ContainersToolbar({
    searchValue,
    onSearchChange,
}: {
    searchValue: string
    onSearchChange: (value: string) => void
}) {
    const searchInputRef = useRef<HTMLInputElement>(null)

    return (
        <div className="sm:flex sm:items-start">
            <div className="sm:flex-auto">
                <div className="w-full max-w-xs">
                    <label htmlFor="container-search" className="sr-only">
                        Search containers
                    </label>
                    <div className="relative">
                        <Search 
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-faint" 
                            aria-hidden="true" 
                        />
                        <input
                            ref={searchInputRef}
                            type="text"
                            id="container-search"
                            name="container-search"
                            value={searchValue}
                            onChange={(e) => onSearchChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    searchInputRef.current?.blur()
                                }
                            }}
                            className="block w-full rounded-md border border-edge-strong focus:border-edge-strong py-1 pl-9 pr-3 text-ink ring-0 ring-edge-strong placeholder:text-ink-faint focus:ring-4 outline-none focus:ring-edge sm:text-xs sm:leading-6"
                            placeholder="Search containers"
                            autoComplete="off"
                        />
                    </div>
                </div>
            </div>
        </div>
    )
}
