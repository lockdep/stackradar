'use client';

import Link from 'next/link';
import { ArrowRight, KeyRound } from 'lucide-react';
import type { Cluster } from '@/types/cluster';

/** Where the banner sends the reader: the cluster Overview's Coverage card. */
export const COVERAGE_ANCHOR = 'coverage';

export function coverageHref(clusterId: string): string {
    return `/clusters/${clusterId}#${COVERAGE_ANCHOR}`;
}

/**
 * Org-level notice that at least one cluster cannot pull from a registry.
 *
 * The Coverage card on the cluster page already explains the failure and
 * ships the fix; this exists because nobody opens that page to look for it. A
 * registry-auth failure is the one coverage gap that never resolves by itself,
 * and it hides inside a Dashboard whose severity totals look healthy — the
 * unscanned images simply contribute zero. One line per affected cluster,
 * each linking straight to the card that carries the remediation.
 */
export function RegistryAuthBanner({ clusters }: { clusters: Cluster[] }) {
    const affected = clusters.filter((c) => c.registryAuthFailedWorkloads > 0);
    if (affected.length === 0) return null;

    return (
        <div role="status" className="mb-6 rounded-md border border-danger-muted bg-danger-subtle px-4 py-3">
            <div className="flex items-start gap-2.5">
                <KeyRound aria-hidden="true" className="mt-px size-4 shrink-0 text-danger" />
                <div className="min-w-0 flex-1 text-xs text-danger">
                    <p className="font-medium">
                        Registry authentication failed
                        {affected.length === 1 ? ` in ${affected[0].name}` : ` in ${affected.length} clusters`}
                    </p>
                    <p className="mt-1">
                        The scanner cannot pull some images, so they have no SBOM and are missing from every number on
                        this page. Waiting will not fix this one — it needs credentials.
                    </p>
                    <ul className="mt-2 flex flex-col gap-1">
                        {affected.map((c) => {
                            const n = c.registryAuthFailedWorkloads;
                            const hosts = c.registryAuthFailedHosts.join(', ');
                            return (
                                <li key={c.id} className="flex flex-wrap items-center gap-x-2">
                                    <Link
                                        href={coverageHref(c.id)}
                                        className="inline-flex items-center gap-1 font-medium hover:underline"
                                    >
                                        {c.name}
                                        <ArrowRight aria-hidden="true" className="size-3" />
                                    </Link>
                                    <span className="text-danger/80">
                                        {n} {n === 1 ? 'container' : 'containers'}
                                        {hosts && (
                                            <>
                                                {' · '}
                                                <span className="font-mono">{hosts}</span>
                                            </>
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </div>
    );
}
