import { type ReactNode } from 'react';

// Variants are named for meaning, not colour — the colours come from theme.css.
const variantStyles = {
    neutral: 'text-neutral bg-neutral-subtle ring-1 ring-inset ring-neutral-muted',
    muted: 'text-ink-muted bg-surface-muted border border-dashed border-edge-strong',
    accent: 'text-accent bg-accent-subtle ring-1 ring-inset ring-accent-muted',
    success: 'text-success bg-success-subtle ring-1 ring-inset ring-success-muted',
    attention: 'text-attention bg-attention-subtle ring-1 ring-inset ring-attention-muted',
    danger: 'text-danger bg-danger-subtle ring-1 ring-inset ring-danger-muted',
    info: 'text-info bg-info-subtle ring-1 ring-inset ring-info-muted',
    inverted: 'text-surface bg-ink',
} as const;

type BadgeVariant = keyof typeof variantStyles;

type BadgeProps = {
    children: ReactNode;
    variant?: BadgeVariant;
    pill?: boolean;
    className?: string;
};

export function Badge({ children, variant = 'neutral', pill = false, className = '' }: BadgeProps) {
    return (
        <span
            className={`inline-flex items-center text-xs font-medium ${
                pill ? 'rounded-full px-2.5 py-0.5' : 'px-1.5 py-0.5'
            } ${variantStyles[variant]} ${className}`}
        >
            {children}
        </span>
    );
}
