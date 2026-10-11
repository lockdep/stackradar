'use client';

import { OccurrencesPopover, type OccurrenceRow } from './OccurrencesPopover';
import { shortDigest } from '@/utils/containerUtils';
import type { Container } from '@/types/container';

/** The slice of the release detail payload the popover reads. */
type ReleaseOccurrences = {
    workloads: Pick<
        Container,
        'id' | 'name' | 'workloadId' | 'workloadName' | 'workloadKind' | 'namespaceName' | 'clusterId'
    >[];
    images: {
        imageId: string;
        digest: string;
        registry: string | null;
        repository: string | null;
        imageTag: string | null;
    }[];
};

type Props = {
    releaseId: string;
    /** What to call the release in the heading — chart name, or release name when unknown. */
    label: string;
    kind: 'images' | 'containers';
    count: number;
};

/**
 * A count cell of the Charts tab that opens to the things it counts — the
 * containers or images one release deploys, each a link to its detail page.
 * The Charts-tab twin of the Packages tab's `PackageOccurrencesPopover`.
 *
 * It fetches the release detail endpoint when the popover opens, not with the
 * table: the endpoint resolves attribution and findings per release, and the
 * table already carries the numbers — resolving every row's contents eagerly
 * would multiply the page load by its own row count.
 */
export function ReleaseOccurrencesPopover({ releaseId, label, kind, count }: Props) {
    return (
        <OccurrencesPopover<ReleaseOccurrences>
            count={count}
            ariaLabel={`${count} ${kind === 'images' ? 'images' : 'containers'} deployed by ${label} — show which`}
            url={`/api/releases/${releaseId}`}
            heading={kind === 'images' ? `${label} deploys these images` : `${label} deploys these containers`}
            emptyNote={
                kind === 'images'
                    ? 'No images — nothing the scanner reported for this release references one.'
                    : 'No containers visible — the release exists, but nothing the scanner could see carries its metadata.'
            }
            errorNote="Could not load the release."
            rows={(data) => releaseOccurrenceRows(data, kind)}
        />
    );
}

function releaseOccurrenceRows(data: ReleaseOccurrences, kind: 'images' | 'containers'): OccurrenceRow[] {
    if (kind === 'images') {
        return data.images.map((image) => ({
            key: image.imageId,
            href: `/images/${image.imageId}`,
            kind: 'image' as const,
            primary: image.repository ?? image.registry ?? image.digest,
            secondary: `${shortDigest(image.digest)}${image.imageTag ? ` · ${image.imageTag}` : ''}`,
        }));
    }

    /* The rows are containers — the addressable unit, since the workload
       detail page is a container page. The container name is only worth a
       reader's eye when one workload contributes more than one row. */
    const multiContainer = new Set(
        data.workloads.map((w) => w.workloadId).filter((id, i, ids) => ids.indexOf(id) !== i),
    );

    return data.workloads.map((w) => ({
        key: w.id,
        href: `/clusters/${w.clusterId}/containers/${w.id}`,
        kind: 'container' as const,
        primary: `${w.namespaceName}/${w.workloadName}`,
        secondary: `${w.workloadKind ?? 'Unknown kind'}${multiContainer.has(w.workloadId) ? ` · ${w.name}` : ''}`,
    }));
}
