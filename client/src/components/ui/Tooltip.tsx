'use client';

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';

/** What tells the reader a definition is there before they hover. */
export type TooltipCue = 'underline' | 'icon' | 'none';

interface TooltipProps {
    /** The definition. Plain text: it is also the trigger's accessible description. */
    text: string;
    children: ReactNode;
    cue?: TooltipCue;
    /** Which side of the trigger the bubble opens on. Bottom by default, since most triggers sit at the top of a clipped scroller. */
    placement?: 'top' | 'bottom';
    /** Which edge of the trigger the bubble lines up with. `end` for a right-aligned column, so the bubble does not run off the table. */
    align?: 'start' | 'center' | 'end';
    /**
     * Whether the trigger is its own tab stop. `false` inside a button or a
     * link — nested focusable content is invalid there, and the bubble opens
     * on the enclosing control's keyboard focus instead.
     */
    focusable?: boolean;
    className?: string;
}

const PLACEMENT = {
    top: 'bottom-full mb-1.5',
    bottom: 'top-full mt-1.5',
} as const;

const ALIGN = {
    start: 'left-0',
    center: 'left-1/2 -translate-x-1/2',
    end: 'right-0',
} as const;

const CUE = {
    underline: 'cursor-help underline decoration-dotted decoration-ink-faint underline-offset-2',
    icon: 'cursor-help',
    none: '',
} as const;

/**
 * A word with its definition one hover away — and a visible sign that there
 * is one, which the native `title` attribute never gives. The bubble is in
 * the DOM at all times as the trigger's `aria-describedby` target, so a
 * screen reader gets the definition whether or not it is drawn; sighted
 * readers get it on hover and on keyboard focus, and Escape puts it away.
 *
 * Inverted (`bg-ink text-surface`), the one tooltip style the theme names.
 * Positioned off the trigger, not portalled: a definition is a few words,
 * and the places that need one (table headers, cells, card subtitles) are
 * never so close to an edge that a bubble below them is clipped.
 */
export function Tooltip({
    text,
    children,
    cue = 'underline',
    placement = 'bottom',
    align = 'center',
    focusable = true,
    className = '',
}: TooltipProps) {
    const id = useId();
    const [engaged, setEngaged] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    /* Escape while hovered, with focus elsewhere: the key goes to whatever is
       focused, so only a document listener sees it. Bound while the bubble is
       up, and nothing else. */
    useEffect(() => {
        if (!engaged) return;
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setDismissed(true);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [engaged]);

    const open = () => {
        setEngaged(true);
        setDismissed(false);
    };
    const close = () => setEngaged(false);
    const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key === 'Escape') setDismissed(true);
    };

    const shown = engaged && !dismissed;

    return (
        <span
            className={`group/tip relative inline-flex items-center ${className}`}
            onMouseEnter={open}
            onMouseLeave={close}
            onFocus={open}
            onBlur={close}
            onKeyDown={onKeyDown}
        >
            <span
                tabIndex={focusable ? 0 : undefined}
                aria-describedby={id}
                className={`inline-flex items-center gap-0.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis ${CUE[cue]}`}
            >
                {children}
                {cue === 'icon' && <Info aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />}
            </span>
            {/* `[a:focus-visible_&]` / `[button:focus-visible_&]`: a trigger that
                is not its own tab stop shows the bubble when the control it
                sits in takes keyboard focus. `hidden` once dismissed, so the
                CSS rule cannot bring it back until the pointer or focus leaves
                and returns. */}
            <span
                role="tooltip"
                id={id}
                className={`pointer-events-none absolute z-50 w-max max-w-64 rounded-md bg-ink px-2 py-1.5 text-left text-xs font-normal normal-case whitespace-normal text-surface shadow-floating ${PLACEMENT[placement]} ${ALIGN[align]} ${
                    dismissed
                        ? 'hidden'
                        : shown
                          ? 'visible opacity-100'
                          : 'invisible opacity-0 [a:focus-visible_&]:visible [a:focus-visible_&]:opacity-100 [button:focus-visible_&]:visible [button:focus-visible_&]:opacity-100'
                }`}
            >
                {text}
            </span>
        </span>
    );
}
