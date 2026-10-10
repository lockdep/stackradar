/**
 * A keyboard shortcut hint: one cap holding every key of the chord — `⌘ K`,
 * `Ctrl K`, `/`. Drawn the way PostHog draws theirs: the app's text face at
 * 12px (not monospace), a hairline border, the raised surface, a 20px cap
 * with a minimum width so a lone glyph is a square, and the keys of a chord
 * set side by side inside it with a 2px gap rather than as separate caps.
 * Decorative — the shortcut is announced in prose where it matters.
 */
export function Kbd({ keys, className = '' }: { keys: string[]; className?: string }) {
    return (
        <kbd
            aria-hidden="true"
            className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-x-0.5 rounded-sm border border-edge-strong bg-surface-raised px-1 font-sans text-xs font-normal leading-none text-ink-secondary ${className}`}
        >
            {keys.map((key, i) => (
                <span key={i}>{key}</span>
            ))}
        </kbd>
    )
}
