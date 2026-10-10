'use client'

import Link from 'next/link'
import { KeyRound, Radio, Terminal } from 'lucide-react'
import { buttonClasses } from '@/components/ui'
import { useRuntimeConfig } from '@/components/providers'
import { InventoryProgress } from './InventoryProgress'
import type { Cluster } from '@/types/cluster'

type WaitingStage = 'no-key' | 'not-installed' | 'connected'

/**
 * Where a cluster is on the install path, from what the control plane can
 * actually observe about it.
 *
 * Three genuinely different next actions, and naming them beats one generic
 * "open cluster" link: no key means nothing can authenticate yet, a key that
 * has never been used means the Helm command hasn't run, and a scanner that
 * has checked in is already working and needs no action at all.
 */
function stageOf(cluster: Cluster): WaitingStage {
    if (!cluster.hasApiKey) return 'no-key'
    if (cluster.scannerLastSeenAt === null) return 'not-installed'
    return 'connected'
}

/* The furthest-along cluster is the one the page header should describe: with a
   cluster already reporting, "no API key yet" is not the org's situation. */
const STAGE_ORDER: WaitingStage[] = ['no-key', 'not-installed', 'connected']

/**
 * The org-level counterpart to the cluster tabs' empty state: clusters exist,
 * but none of them has reported a workload yet.
 *
 * The header asserts only what was checked. It previously said "no workloads
 * have been reported yet" in every case — including when the reason was that
 * the user had never run `helm install`, and including (because the check ran
 * against hourly snapshots rather than live rows) when workloads *had* been
 * reported. The stage ladder below is the same one each row uses, lifted to
 * page level. The install command itself stays on the cluster page, because
 * with several clusters there is no single right command to show.
 */
export function ClustersAwaitingScanner({ clusters }: { clusters: Cluster[] }) {
    /* The community edition installs its own scanner; the two "do this"
       stages have no install command to point at, only configuration. */
    const { edition } = useRuntimeConfig()
    const selfScanning = !edition.multiCluster
    const stages = clusters.map(stageOf)
    const furthest = STAGE_ORDER.filter(s => stages.includes(s)).at(-1) ?? 'no-key'
    const plural = clusters.length > 1
    /* Both counts off the cluster payload, where the server counted them over
       the same rows — never a client-side count, which measures a
       different population. */
    const discovered = clusters.reduce((n, c) => n + (c.discoveredWorkloads ?? 0), 0)
    const scanned = clusters.reduce((n, c) => n + (c.scannedWorkloads ?? 0), 0)

    const header = {
        'no-key': selfScanning
            ? {
                  title: 'No scanner key on the server',
                  body: 'The cluster exists but the server has no BOOTSTRAP_CLUSTER_API_KEY to accept its scanner with. Set it and restart the server.',
              }
            : {
                  title: 'Finish connecting your cluster',
                  body: `Generate an API key to get the Helm command that installs the scanner${plural ? ' for each cluster' : ''}.`,
              },
        'not-installed': selfScanning
            ? {
                  title: 'Waiting for the scanner to check in',
                  body: 'The scanner installed with StackRadar has not reported yet. It usually does within a minute of starting; if it does not, check its pod logs for the server URL and key it was given. This page keeps checking, so there\'s no need to refresh.',
              }
            : {
                  title: 'Scanner not installed yet',
                  body: `The API key has never been used, so the scanner has not checked in. Run the install command from the cluster page${plural ? ' for each cluster below' : ''} — this page keeps checking, so there's no need to refresh.`,
              },
        connected: {
            /* The count is the whole point of saying anything here: "generating
               SBOMs" with no denominator is indistinguishable from a hang. */
            title: discovered > 0
                ? `Scanner connected — ${discovered.toLocaleString()} container${discovered === 1 ? '' : 's'} discovered`
                : 'Scanner connected — generating your first SBOMs',
            body: 'The scanner has checked in and is pulling each image to build its SBOM. Expect the first findings within minutes; they appear here as soon as they land — no need to refresh.',
        },
    }[furthest]

    return (
        <div className="mt-8 rounded-md border border-edge bg-surface-raised shadow-resting">
            <div className="flex items-start gap-4 px-6 py-5 border-b border-edge">
                <div className="relative shrink-0 flex items-center justify-center size-10 rounded-md bg-surface-muted ring-1 ring-edge">
                    <span className="absolute size-5 rounded-full bg-success-subtle animate-ping" />
                    <span className="relative size-2.5 rounded-full bg-accent-emphasis" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-ink">{header.title}</h3>
                    <p className="mt-1 text-sm text-ink-muted">{header.body}</p>
                    {furthest === 'connected' && (
                        <div className="mt-3">
                            <InventoryProgress discovered={discovered} scanned={scanned} />
                        </div>
                    )}
                </div>
            </div>
            <ul role="list" className="divide-y divide-edge">
                {clusters.map((cluster, i) => (
                    <ClusterWaitingRow key={cluster.id} cluster={cluster} stage={stages[i]!} selfScanning={selfScanning} />
                ))}
            </ul>
        </div>
    )
}

const ROW_STATE = {
    'no-key': {
        icon: KeyRound,
        label: 'No API key yet',
        detail: 'Generate one to get an install command',
        cta: 'Set up',
    },
    'not-installed': {
        icon: Terminal,
        label: 'Scanner not installed',
        detail: 'The API key has never been used',
        cta: 'View install command',
    },
    connected: {
        icon: Radio,
        label: 'Scanner connected',
        detail: 'First SBOMs are on the way',
        cta: 'View cluster',
    },
} as const

function ClusterWaitingRow({ cluster, stage, selfScanning }: { cluster: Cluster; stage: WaitingStage; selfScanning: boolean }) {
    const state = ROW_STATE[stage]
    const Icon = state.icon
    const found = cluster.discoveredWorkloads ?? 0
    const detail = stage === 'connected' && found > 0
        ? `${found.toLocaleString()} container${found === 1 ? '' : 's'} found, SBOMs generating`
        : selfScanning && stage === 'no-key'
            ? 'The server has no bootstrap key'
            : selfScanning && stage === 'not-installed'
                ? 'The scanner has not checked in yet'
                : state.detail
    /* Nothing to "set up" or "install" from here in the community edition. */
    const cta = selfScanning && stage !== 'connected' ? 'View cluster' : state.cta

    return (
        <li className="flex items-center gap-4 px-6 py-4">
            <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{cluster.name}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                    {state.label} — {detail}
                </p>
            </div>
            <Link href={`/clusters/${cluster.id}`} className={buttonClasses({ variant: 'secondary' })}>
                {cta}
            </Link>
        </li>
    )
}
