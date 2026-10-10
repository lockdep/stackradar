'use client'

import { useState } from 'react'
import { Check, ClipboardCopy } from 'lucide-react'

export function useCopy(text: string) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            /* clipboard unavailable — the text is still selectable */
        }
    }
    return { copied, copy }
}

type CodeBlockVariant = 'default' | 'light' | 'dark'

const VARIANT_STYLES: Record<CodeBlockVariant, { pre: string; button: string; copied: string }> = {
    /* The compact theme-following form used across the app. */
    default: {
        pre: 'bg-surface-muted p-3 pr-12 text-ink ring-1 ring-edge',
        button: 'top-1.5 right-1.5 bg-surface-raised text-ink-faint ring-1 ring-edge hover:bg-surface-hover hover:text-ink',
        copied: 'text-success',
    },
    /* The install panel's roomier form, in its light theme. */
    light: {
        pre: 'bg-surface-muted p-4 pr-14 text-ink ring-1 ring-edge',
        button: 'top-2 right-2 bg-surface-raised text-ink-faint ring-1 ring-edge hover:bg-surface-hover hover:text-ink',
        copied: 'text-success',
    },
    /* Deliberately always-dark, for the install panel inside a dark dialog. */
    dark: {
        pre: 'bg-gray-950 p-4 pr-14 text-gray-100 ring-1 ring-white/10',
        button: 'top-2 right-2 bg-white/5 text-ink-faint/70 hover:bg-white/10 hover:text-white',
        copied: 'text-emerald-400',
    },
}

/**
 * A `<kebab-case>` token the reader must replace before running the command.
 * Anchored on lowercase kebab inside angle brackets so a shell redirect or a
 * real `<` in a jsonpath can never match.
 */
const PLACEHOLDER = /(<[a-z][a-z0-9-]*>)/g

/**
 * Splits code into literal text and placeholder tokens. The token keeps its
 * angle brackets — they are the convention the reader recognises — but is
 * styled so the one thing to change stands out from everything to keep.
 */
function renderWithPlaceholders(code: string): React.ReactNode[] {
    return code.split(PLACEHOLDER).map((part, i) =>
        i % 2 === 1 ? (
            <span
                key={i}
                className="rounded-sm bg-accent-subtle px-0.5 text-accent italic ring-1 ring-inset ring-accent-muted"
                title={`Replace with your ${part.slice(1, -1).replace(/-/g, ' ')}`}
            >
                {part}
            </span>
        ) : (
            part
        ),
    )
}

/**
 * A copy-pasteable command. `variant` covers the install panel's two themed
 * forms (`ConnectClusterInstructions` used to keep its own re-implementation);
 * `sensitive` marks the block `ph-no-capture` so its content never lands in
 * PostHog session replay.
 */
export function CodeBlock({
    code,
    variant = 'default',
    sensitive = false,
    placeholders = false,
}: {
    code: string
    variant?: CodeBlockVariant
    sensitive?: boolean
    /**
     * Highlight `<placeholder>` tokens. Display only — the copied text is the
     * plain `code` string either way.
     */
    placeholders?: boolean
}) {
    const { copied, copy } = useCopy(code)
    const styles = VARIANT_STYLES[variant]

    return (
        <div className={`group relative${sensitive ? ' ph-no-capture' : ''}`}>
            <pre className={`overflow-x-auto rounded-md font-mono text-[13px] leading-relaxed whitespace-pre ${styles.pre}`}>
                {placeholders ? renderWithPlaceholders(code) : code}
            </pre>
            <button
                type="button"
                onClick={copy}
                className={`absolute cursor-pointer rounded-md p-1.5 transition-colors ${styles.button}`}
                title="Copy to clipboard"
            >
                {copied ? (
                    <Check className={`size-4 ${styles.copied}`} />
                ) : (
                    <ClipboardCopy className="size-4" />
                )}
            </button>
        </div>
    )
}
