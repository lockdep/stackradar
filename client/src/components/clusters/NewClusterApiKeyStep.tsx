'use client'

import { Check, ClipboardCopy } from 'lucide-react'
import type { Cluster } from '@/types/cluster'

interface NewClusterApiKeyStepProps {
    cluster: Cluster
    apiKey: string
    copied: boolean
    onCopy: () => void
}

/**
 * Step 2: the one-time reveal of the just-minted scanner key. Deliberately
 * not `ui/CodeBlock` — this is a wrapping key readout with an external copy
 * button, not a scrollable command block.
 */
export function NewClusterApiKeyStep({ cluster, apiKey, copied, onCopy }: NewClusterApiKeyStepProps) {
    return (
        <div className="space-y-4">
            <div className="rounded-md bg-success-subtle border border-success-muted p-4">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5 rounded-full bg-accent-emphasis p-0.5">
                        <Check className="size-3.5 text-on-emphasis" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-success">
                            Cluster <span className="font-semibold">{cluster.name}</span> created
                        </p>
                        <p className="text-xs text-success/70 font-mono truncate mt-0.5">{cluster.id}</p>
                    </div>
                </div>
            </div>

            <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-secondary mb-2">
                    API key
                </label>
                <div className="flex items-center gap-2">
                    {/* ph-no-capture: keep the one-time key out of PostHog session replay */}
                    <div className="ph-no-capture flex-1 bg-surface-muted rounded-md ring-1 ring-edge px-4 py-3 font-mono text-sm text-ink overflow-hidden">
                        <span className="break-all">{apiKey}</span>
                    </div>
                    <button
                        type="button"
                        onClick={onCopy}
                        className="p-2.5 text-ink-muted hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors cursor-pointer"
                        title="Copy key"
                    >
                        {copied ? <Check className="size-5 text-success" /> : <ClipboardCopy className="size-5" />}
                    </button>
                </div>

                <div className="mt-4 rounded-md bg-attention-subtle border border-attention-muted p-3 space-y-1.5">
                    <p className="text-xs text-attention">
                        <strong>Save this key now.</strong> This is the only time you&apos;ll
                        see the full key. You&apos;ll paste it into the Helm install command in the next step.
                    </p>
                    <p className="text-xs text-attention/80">
                        If you lose it, you can rotate it from cluster settings — your scanner will need updating with the new key.
                    </p>
                </div>
            </div>
        </div>
    )
}
