'use client'

import { useState } from 'react'
import { DialogTitle } from '@headlessui/react'
import { ArrowRight, CircleArrowUp } from 'lucide-react'
import { Button, CodeBlock, DetailDialog } from '@/components/ui'
import { useRuntimeConfig } from '@/components/providers'
import type { Cluster } from '@/types/cluster'
import { helmUpgradeCommand, isScannerOutdated, SCANNER_RELEASES_URL } from './scannerInstall'

const ROLLOUT_CHECK =
    'kubectl rollout status deployment/stackradar-scanner-watcher -n stackradar'

/**
 * Notice that a cluster's scanner is older than the release the app
 * advertises (`SCANNER_CHART_VERSION`, the same runtime value the install
 * command pins), with the `helm upgrade` one click away.
 *
 * Takes a list so the Dashboard and the cluster page share it — the cluster
 * page passes its one cluster. The upgrade command carries no cluster
 * identity (it feeds the release's own values back in), so one dialog
 * serves however many clusters are behind.
 *
 * Silent in the live demo: its "scanner" is the charts worker's reporter, and
 * nobody watching the demo can upgrade it.
 */
export function ScannerUpdateBanner({ clusters }: { clusters: Cluster[] }) {
    const { scannerChartVersion, demoMode } = useRuntimeConfig()
    const [isOpen, setIsOpen] = useState(false)

    const outdated = clusters.filter(c => isScannerOutdated(c.scannerVersion, scannerChartVersion))
    if (demoMode || !scannerChartVersion || outdated.length === 0) return null

    const single = outdated.length === 1 ? outdated[0] : null

    return (
        <>
            <div
                role="status"
                className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-accent-muted bg-accent-subtle px-4 py-3"
            >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <CircleArrowUp aria-hidden="true" className="mt-px size-4 shrink-0 text-accent" />
                    <p className="min-w-0 text-xs text-ink">
                        <span className="font-medium">
                            Scanner <span className="font-mono">{scannerChartVersion}</span> is available.
                        </span>{' '}
                        <span className="text-ink-secondary">
                            {single ? (
                                <>
                                    {single.name} is running{' '}
                                    <span className="font-mono">{single.scannerVersion}</span>.
                                </>
                            ) : (
                                <>{outdated.length} clusters are running an older version.</>
                            )}
                        </span>
                    </p>
                </div>
                <Button size="sm" onClick={() => setIsOpen(true)}>
                    How to update
                </Button>
            </div>

            <DetailDialog isOpen={isOpen} onClose={() => setIsOpen(false)}>
                <div className="border-b border-edge px-6 pt-6 pb-4 pr-14">
                    <DialogTitle className="text-xl font-bold leading-tight text-ink">
                        Update the scanner to <span className="font-mono">{scannerChartVersion}</span>
                    </DialogTitle>
                    <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-secondary">
                        {outdated.map(c => (
                            <li key={c.id} className="flex flex-wrap items-center gap-x-2">
                                <span className="font-medium text-ink">{c.name}</span>
                                <span className="inline-flex items-center gap-1.5 font-mono">
                                    <span className="text-ink-muted">{c.scannerVersion}</span>
                                    <ArrowRight aria-hidden="true" className="size-3 text-ink-muted" />
                                    <span className="text-ink">{scannerChartVersion}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
                    <div>
                        <h3 className="text-sm font-semibold text-ink">Upgrade the chart</h3>
                        <p className="mt-1 mb-3 text-xs text-ink-muted">
                            Run this against {single ? 'the cluster' : 'each cluster listed above'}.{' '}
                            It reads the settings of the installed release and applies them to the new
                            chart, so credentials and every option you set carry over and there is no key to paste.
                        </p>
                        <CodeBlock code={helmUpgradeCommand(scannerChartVersion)} />
                    </div>

                    <div>
                        <h3 className="text-sm font-semibold text-ink">Check the rollout</h3>
                        <p className="mt-1 mb-3 text-xs text-ink-muted">
                            The new version shows up here on the scanner&apos;s next heartbeat, and this notice
                            goes away with it.
                        </p>
                        <CodeBlock code={ROLLOUT_CHECK} />
                    </div>

                    <p className="text-xs text-ink-muted">
                        What changed is on the{' '}
                        <a
                            href={SCANNER_RELEASES_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent underline"
                        >
                            releases page
                        </a>
                        .
                    </p>
                </div>
            </DetailDialog>
        </>
    )
}
