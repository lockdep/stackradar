'use client'

import { useMemo } from 'react'
import { CodeBlock } from '@/components/ui'
import { useRuntimeConfig } from '@/components/providers'
import {
    helmInstallCommand,
    SCANNER_DEFAULT_API_URL,
    SCANNER_DOCS_URL,
    SCANNER_RELEASES_URL,
} from './scannerInstall'

interface ConnectClusterInstructionsProps {
    clusterId: string
    clusterName?: string
    /**
     * The plaintext API key, only available the one time it was just generated.
     * When `null`, commands show a placeholder that users can substitute.
     */
    apiKey: string | null
    /**
     * Where the scanner should send SBOMs. When omitted the chart default is used.
     */
    apiUrl?: string
    /**
     * Visual theme. Defaults to `light`. Code blocks stay dark regardless.
     */
    variant?: 'light' | 'dark'
}

const API_KEY_PLACEHOLDER = '<your-api-key>'

function useResolvedApiUrl(apiUrl?: string): string {
    return useMemo(() => {
        if (apiUrl) return apiUrl.replace(/\/$/, '')
        return SCANNER_DEFAULT_API_URL
    }, [apiUrl])
}

function StepLabel({ n, label, isDark, labelClass }: { n: number; label: string; isDark: boolean; labelClass: string }) {
    return (
        <div className="flex items-center gap-2 mb-2">
            <span className={`flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${isDark ? 'bg-white/10 text-white' : 'bg-ink text-surface'}`}>
                {n}
            </span>
            <span className={`text-xs font-semibold uppercase tracking-wider ${labelClass}`}>{label}</span>
        </div>
    )
}

export function ConnectClusterInstructions({
    clusterId,
    clusterName,
    apiKey,
    apiUrl,
    variant = 'light',
}: ConnectClusterInstructionsProps) {
    const resolvedApiUrl = useResolvedApiUrl(apiUrl)
    const { scannerChartVersion } = useRuntimeConfig()

    const isDark = variant === 'dark'
    const subtleClass = isDark ? 'text-ink-faint' : 'text-ink-muted'
    const labelClass = isDark ? 'text-ink-faint/70' : 'text-ink-secondary'

    const key = apiKey ?? API_KEY_PLACEHOLDER
    const keyIsMissing = !apiKey

    const helmInstall = helmInstallCommand({ chartVersion: scannerChartVersion, apiUrl: resolvedApiUrl })

    const createSecret = [
        'kubectl create secret generic stackradar-scanner \\',
        '  --namespace stackradar \\',
        `  --from-literal=cluster-id="${clusterId}" \\`,
        `  --from-literal=api-key="${key}"`,
    ].join('\n')

    return (
        <div className="space-y-5">
            <div>
                <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-ink'}`}>
                    Install the scanner
                </h3>
                <p className={`mt-1 text-sm ${subtleClass}`}>
                    Install the chart{clusterName ? ` in ${clusterName}` : ''}, then create the credentials
                    secret. The watcher pod waits for the secret before it becomes ready.
                </p>
            </div>

            <div>
                <StepLabel n={1} label="Install the chart" isDark={isDark} labelClass={labelClass} />
                <CodeBlock code={helmInstall} variant={variant} />
                <p className={`mt-2 text-xs ${subtleClass}`}>
                    {scannerChartVersion ? (
                        <>
                            Pinned to <span className="font-mono">{scannerChartVersion}</span>, the current release —
                            published versions are immutable, so the install is reproducible. Older and newer
                            versions are on the{' '}
                        </>
                    ) : (
                        <>
                            Always pass an explicit <span className="font-mono">--version</span> — published versions
                            are immutable, so pinning one pins exact bytes. The latest is on the{' '}
                        </>
                    )}
                    <a
                        href={SCANNER_RELEASES_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`underline ${isDark ? 'text-blue-400' : 'text-accent'}`}
                    >
                        releases page
                    </a>.
                </p>
            </div>

            <div>
                <StepLabel n={2} label="Create the secret" isDark={isDark} labelClass={labelClass} />
                <CodeBlock code={createSecret} variant={variant} sensitive />
                {keyIsMissing && (
                    <p className={`mt-2 text-xs ${isDark ? 'text-amber-300' : 'text-attention'}`}>
                        Replace <span className="font-mono">{API_KEY_PLACEHOLDER}</span> with your actual API key
                        before running.
                    </p>
                )}
                <p className={`mt-1.5 text-xs ${subtleClass}`}>
                    Use the copy button above to avoid formatting issues.
                </p>
            </div>

            <div>
                <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-ink'}`}>
                    Check scanner status
                </h3>
                <p className={`mt-1 text-sm ${subtleClass}`}>
                    Verify the scanner pod is running.
                </p>
                <div className="mt-3">
                    <CodeBlock
                        code={`kubectl rollout status deployment/stackradar-scanner-watcher -n stackradar\nkubectl logs -n stackradar -l app.kubernetes.io/name=stackradar-scanner,app.kubernetes.io/component=watcher -f`}
                        variant={variant}
                    />
                </div>
            </div>

            <p className={`text-xs ${subtleClass}`}>
                For more configuration options, see the{' '}
                <a
                    href={SCANNER_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`underline ${isDark ? 'text-blue-400' : 'text-accent'}`}
                >
                    chart documentation on GitHub
                </a>.
            </p>
        </div>
    )
}
