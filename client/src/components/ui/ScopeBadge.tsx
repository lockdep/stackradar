import { Badge } from './Badge'

type ScopeBadgeProps = {
    isDirect: boolean
}

export function ScopeBadge({ isDirect }: ScopeBadgeProps) {
    return (
        <span className="relative group/scope">
            <Badge variant={isDirect ? 'accent' : 'muted'}>
                {isDirect ? 'Direct' : 'Transitive'}
            </Badge>
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-surface bg-ink rounded-sm opacity-0 group-hover/scope:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                {isDirect
                    ? 'Declared in the image\u2019s package manifest'
                    : 'Pulled in by another dependency'}
                <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-ink" />
            </span>
        </span>
    )
}
