'use client'

import { useState, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useResource } from '@/hooks'
import {
    ArrowLeft,
    FileText,
    Package,
    ShieldAlert,
    ShieldCheck,
} from 'lucide-react'
import { SiKubernetes } from 'react-icons/si'

import type { Container, ContainerExposure } from '@/types/container'
import { formatImageTag, isDigestLikeTag } from '@/utils/formatters'
import {
    DependenciesTab,
    DeploymentsTab,
    ImageSbomTab,
    OsvSyncTab,
    VulnerabilitiesTab,
    ContainerOriginStrip,
    type Tab,
} from '@/components/container-detail'
import { ExposureDuration, TabBar, TabPanel } from '@/components/ui'

/**
 * One running container.
 *
 * The header names the container; everything below it describes the **image**
 * the container references — components, findings, scan history are all
 * properties of the digest, shared by every place it runs. That split is why
 * there is a Deployments tab: it is the list of other places the same answer
 * applies to.
 *
 * There is no rescan action. Findings refresh on the backend's clock — every
 * mirror-changing OSV sync re-queues a match for the whole fleet — so a
 * button here could only duplicate work that is already scheduled, and its
 * real effect (nothing visible for seconds, then the same numbers) reads as
 * broken. The "Checked" timestamp is the honest surface for freshness.
 *
 * There is no Settings tab and no delete. A container is discovered from the
 * cluster, so deleting it here would either lie (it returns on the next
 * inventory report) or delete the wrong thing (the image, which other
 * containers may still be running).
 */
export function ContainerDetailView({
    container,
    cluster,
}: {
    container: Container
    cluster: { id: string; name: string }
}) {
    const router = useRouter()
    const [activeTab, setActiveTab] = useState<Tab>('vulnerabilities')
    // One read for the header line and the findings table's Exposed column. A
    // failed read (or an older server) leaves both out rather than erroring.
    const { data: exposure } = useResource<ContainerExposure>(`/api/containers/${container.id}/exposure`)

    // The reference without its digest, so the header reads as the thing the
    // pod spec asked for rather than 71 characters of hex.
    const imageRefDisplay = container.imageRef.split('@')[0] ?? null
    const imageTagSplit = imageRefDisplay ? imageRefDisplay.lastIndexOf(':') : -1
    const refTag = imageTagSplit > 0 ? imageRefDisplay!.slice(imageTagSplit + 1) : null
    // A digest-like "tag" in the ref means the ref was a bare image ID
    // (`sha256:…`) — not a name at all, so nothing to split.
    const refTagUsable = refTag !== null && !isDigestLikeTag(refTag)
    const imageBase = refTagUsable ? imageRefDisplay!.slice(0, imageTagSplit + 1) : imageRefDisplay
    // A ref with no tag is digest-pinned, and the digest is what identifies it
    // — not an invented "latest".
    const imageTag = refTagUsable
        ? refTag
        : formatImageTag(container.imageTag, container.imageDigest)

    const vulns = container.vulnerabilities
    const vulnTotal = vulns ? vulns.critical + vulns.high + vulns.medium + vulns.low : undefined

    const tabs = [
        { id: 'vulnerabilities' as Tab, name: 'Vulnerabilities', icon: ShieldAlert, count: vulnTotal },
        { id: 'dependencies' as Tab, name: 'Dependencies', icon: Package },
        { id: 'sbom' as Tab, name: 'SBOM', icon: FileText },
        { id: 'deployments' as Tab, name: 'Deployments', icon: SiKubernetes },
        { id: 'osv-sync' as Tab, name: 'OSV Sync', icon: ShieldCheck },
    ]

    return (
        <div>
            <div className="mb-6 border-b border-edge pb-4">
                <button
                    onClick={() => router.push(`/clusters/${cluster.id}/containers`)}
                    className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm text-ink-secondary hover:text-ink"
                >
                    <ArrowLeft className="size-4" />
                    Back to Containers
                </button>
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <nav aria-label="Breadcrumb" className="mb-1 text-sm text-ink-muted">
                            <button
                                type="button"
                                onClick={() => router.push('/clusters')}
                                className="cursor-pointer hover:text-ink"
                            >
                                Clusters
                            </button>
                            <span className="mx-1.5 text-ink-faint">/</span>
                            <button
                                type="button"
                                onClick={() => router.push(`/clusters/${cluster.id}`)}
                                className="cursor-pointer hover:text-ink"
                            >
                                {cluster.name}
                            </button>
                        </nav>
                        <h1 className="wrap-break-word text-xl font-bold leading-tight text-ink sm:text-2xl">
                            {container.workloadName}
                            {container.name !== container.workloadName && (
                                <span className="text-ink-muted"> / {container.name}</span>
                            )}
                        </h1>
                        {imageRefDisplay && (
                            <div className="mt-1 break-all">
                                <span className="font-mono text-xs text-ink-muted" title={container.imageRef}>
                                    {imageBase}
                                </span>
                                {imageTag && (
                                    <span className="ml-2 font-mono text-xs font-semibold text-ink-secondary">
                                        {imageTag}
                                    </span>
                                )}
                            </div>
                        )}
                        <ContainerOriginStrip container={container} clusterName={cluster.name} />
                        {exposure?.longest && (
                            <p className="mt-2 text-sm text-ink-secondary">
                                {exposure.longest.kind === 'exploited'
                                    ? 'Running a known-exploited vulnerability for '
                                    : 'Longest-exposed critical or high finding: '}
                                <ExposureDuration
                                    since={exposure.longest.since}
                                    isLowerBound={exposure.longest.isLowerBound}
                                    reason={exposure.longest.lowerBoundReason}
                                    className="font-medium text-ink"
                                />
                                {' · '}
                                <Link
                                    href={`/vulnerabilities/${encodeURIComponent(exposure.longest.vulnId)}`}
                                    className="font-mono text-xs hover:text-accent hover:underline"
                                >
                                    {exposure.longest.vulnId}
                                </Link>
                            </p>
                        )}
                    </div>
                </div>
            </div>

            <TabBar
                tabs={tabs}
                activeTab={activeTab}
                onChange={id => setActiveTab(id as Tab)}
                label="Container sections"
            />

            <TabPanel tabId="dependencies" active={activeTab === 'dependencies'}>
                <DependenciesTab containerId={container.id} />
            </TabPanel>
            <TabPanel tabId="vulnerabilities" active={activeTab === 'vulnerabilities'}>
                {/* Suspense: the findings lens reads the URL. */}
                <Suspense>
                    <VulnerabilitiesTab containerId={container.id} exposure={exposure} />
                </Suspense>
            </TabPanel>
            <TabPanel tabId="sbom" active={activeTab === 'sbom'}>
                <ImageSbomTab containerId={container.id} />
            </TabPanel>
            <TabPanel tabId="deployments" active={activeTab === 'deployments'}>
                <DeploymentsTab containerId={container.id} />
            </TabPanel>
            <TabPanel tabId="osv-sync" active={activeTab === 'osv-sync'}>
                <OsvSyncTab containerId={container.id} />
            </TabPanel>
        </div>
    )
}
