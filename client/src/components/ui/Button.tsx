'use client';

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { Spinner } from './Spinner';

/**
 * Primer's button variants, by their Primer names.
 *
 * `primary` is StackRadar blue (the `accent` family), a deliberate departure
 * from GitHub's green. Blue still also marks links, focus rings and selected
 * states; the filled button is the one place it means "do this". Don't
 * hand-roll a `bg-btn-primary` or `bg-accent-emphasis` button — use this.
 *
 * `selected` is a secondary button whose value is not the default — a filter
 * menu that is narrowing the page. Tinted fill, accent border and accent
 * text, so an active filter is read from across the bar rather than found by
 * its outline. A variant, not classes added to `secondary`: two `bg-*`
 * utilities on one element resolve by emission order, not by intent.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'selected' | 'danger' | 'invisible';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
    primary: 'border-transparent bg-btn-primary text-on-emphasis hover:bg-btn-primary-hover',
    secondary: 'border-edge bg-btn-secondary text-ink hover:bg-btn-secondary-hover',
    selected: 'border-accent-emphasis bg-accent-subtle text-accent hover:bg-accent-muted',
    danger: 'border-transparent bg-danger-emphasis text-on-emphasis hover:bg-danger-emphasis-hover',
    invisible: 'border-transparent text-ink-secondary hover:bg-btn-secondary-hover hover:text-ink',
};

/* Fixed heights, so buttons line up in a toolbar row regardless of whether they
   carry an icon. Radius is Primer's 6px (`rounded-md`) at every size.

   Narrowing one of these from `className` needs the per-side utility: Tailwind
   resolves conflicts by emission order, shorthand → axis → side then ascending by
   value, so `pl-2 pr-2` beats the `px-3` below while `px-2` silently loses to it.
   Same trap as `Table.tsx`'s cell padding. */
const SIZE: Record<ButtonSize, string> = {
    sm: 'h-7 gap-1 px-2.5 text-xs',
    md: 'h-8 gap-1.5 px-3 text-sm',
    lg: 'h-10 gap-2 px-4 text-sm',
};

const BASE =
    'inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap ' +
    'transition-colors cursor-pointer ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
    'disabled:cursor-not-allowed disabled:opacity-60';

interface ButtonStyleOptions {
    variant?: ButtonVariant;
    size?: ButtonSize;
    fullWidth?: boolean;
    className?: string;
}

/**
 * The same classes `<Button>` applies, for the cases that can't be a `<button>`
 * — a `next/link` or a plain anchor. Prefer `<Button>` wherever it fits.
 */
export function buttonClasses({
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    className = '',
}: ButtonStyleOptions = {}) {
    return [BASE, SIZE[size], VARIANT[variant], fullWidth ? 'w-full' : '', className].filter(Boolean).join(' ');
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>, ButtonStyleOptions {
    /** Shows a spinner in place of any leading icon and disables the button. */
    loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        variant = 'secondary',
        size = 'md',
        fullWidth,
        className,
        loading = false,
        disabled,
        children,
        type = 'button',
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || loading}
            className={buttonClasses({ variant, size, fullWidth, className })}
            {...rest}
        >
            {loading && <Spinner size="sm" className={size === 'sm' ? 'size-3.5' : 'size-4'} />}
            {children}
        </button>
    );
});
