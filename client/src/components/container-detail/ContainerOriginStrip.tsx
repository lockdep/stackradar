'use client'

import { Folder } from 'lucide-react'
import { EntityIcon } from '@/components/ui'
import type { Container } from '@/types/container'

type OriginField = {
    icon: React.ReactNode
    label: string
    value: string
    title?: string
}

/**
 * Where this container runs: namespace, kind, cluster, Helm release, chart.
 *
 * Every value comes off the container row itself. It used to be assembled from
 * `sboms.labels` — a bag of pod labels and annotations merged onto the SBOM —
 * which is exactly the conflation ADR 0004 removed: an SBOM that carries a
 * customer's release name cannot be the shareable artefact a public image's
 * SBOM is. The breadcrumbs now live on the deployment side, where they belong,
 * and reading them takes no extra request.
 */
export function ContainerOriginStrip({
    container,
    clusterName,
}: {
    container: Container
    clusterName?: string
}) {
    const fields: OriginField[] = [
        {
            icon: <Folder className="size-3.5 text-ink-muted" />,
            label: 'Namespace',
            value: container.namespaceName,
        },
    ]

    // Omitted rather than shown as "Pod" when the scanner could not resolve
    // `ownerReferences` — a guessed kind becomes a wrong remediation command.
    if (container.workloadKind) {
        fields.push({
            icon: <EntityIcon kind="container" />,
            label: 'Kind',
            value: container.workloadKind,
        })
    }

    if (clusterName) {
        fields.push({
            icon: <EntityIcon kind="cluster" />,
            label: 'Cluster',
            value: clusterName,
        })
    }

    if (container.releaseName) {
        fields.push({
            icon: <EntityIcon kind="chart" />,
            label: 'Helm release',
            value: container.releaseName,
        })
    }

    if (container.chartName) {
        fields.push({
            icon: <EntityIcon kind="chart" />,
            label: 'Chart',
            value: container.chartVersion
                ? `${container.chartName} ${container.chartVersion}`
                : container.chartName,
        })
    }

    return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
            {fields.map(f => (
                <div
                    key={f.label}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge bg-surface-muted px-2 py-1 text-xs"
                    title={f.title ?? `${f.label}: ${f.value}`}
                >
                    {f.icon}
                    <span className="shrink-0 text-ink-muted">{f.label}</span>
                    <span className="min-w-0 truncate font-medium text-ink">{f.value}</span>
                </div>
            ))}
        </div>
    )
}
