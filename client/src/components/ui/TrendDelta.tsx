import { ArrowDown, ArrowUp } from 'lucide-react';

export type TrendDeltaDirection = 'up-bad' | 'neutral';

const colorClass: Record<TrendDeltaDirection, { up: string; down: string }> = {
    'up-bad': {
        up: 'text-danger',
        down: 'text-success',
    },
    neutral: {
        up: 'text-ink-muted',
        down: 'text-ink-muted',
    },
};

export function TrendDelta({ delta, direction = 'up-bad' }: { delta: number; direction?: TrendDeltaDirection }) {
    if (delta === 0) {
        return (
            <span className="text-xs text-ink-muted" title="No change over the selected period">
                ±0
            </span>
        );
    }
    const up = delta > 0;
    const Icon = up ? ArrowUp : ArrowDown;
    return (
        <span
            className={`inline-flex items-center gap-0.5 text-xs font-medium ${colorClass[direction][up ? 'up' : 'down']}`}
            title={`${up ? 'Up' : 'Down'} ${Math.abs(delta).toLocaleString()} over the selected period`}
        >
            <Icon className="size-3" aria-hidden />
            {Math.abs(delta).toLocaleString()}
        </span>
    );
}
