import { VulnerabilityCounts } from '@/components/ui';
import type { VulnerabilityCounts as Counts } from '@/types/container';

/**
 * The right-hand column of the containers list: what is wrong with the row.
 *
 * One component for leaf rows and group rows so the reading cannot drift
 * apart — and so the `null` case is written once. `null` is not zero: it means
 * no SBOM has landed for this image, and rendering four zero squares there tells
 * someone their production container is clean because nobody has opened it.
 */
export function ContainerSeverityCell({
    vulnerabilities,
    aggregated = false,
}: {
    vulnerabilities: Counts | null;
    aggregated?: boolean;
}) {
    if (!vulnerabilities) {
        return (
            <span className="text-ink-muted" title="No SBOM for this image yet">
                —
            </span>
        );
    }

    return (
        <VulnerabilityCounts
            critical={vulnerabilities.critical}
            high={vulnerabilities.high}
            medium={vulnerabilities.medium}
            low={vulnerabilities.low}
            aggregated={aggregated}
        />
    );
}
