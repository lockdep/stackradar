import { Spinner } from './Spinner'

/**
 * The centred loading state a page or tab shows before its first data lands:
 * a large spinner, optionally with a muted line saying what is loading.
 * This exact block was re-typed across most views before it moved here.
 */
export function LoadingBlock({
    label,
    className = 'py-24',
}: {
    /** The muted line under the spinner ("Loading packages..."). */
    label?: string
    /** Vertical padding of the block — a handful of tab panes use `py-12`. */
    className?: string
}) {
    return (
        <div className={`flex items-center justify-center ${className}`}>
            {label ? (
                <div className="flex flex-col items-center gap-3">
                    <Spinner size="lg" className="text-ink-faint" />
                    <p className="text-sm text-ink-muted">{label}</p>
                </div>
            ) : (
                <Spinner size="lg" className="text-ink-faint" />
            )}
        </div>
    )
}
