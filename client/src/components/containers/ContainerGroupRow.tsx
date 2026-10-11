import { ChevronRight } from 'lucide-react';

import type { ContainerGroup } from '@/utils/containerUtils';
import { Badge, TableRow, TableCell } from '@/components/ui';
import { TotalRiskChip } from '@/components/ui';
import { ContainerSeverityCell } from './ContainerSeverityCell';

/**
 * The header row of a namespace group.
 *
 * Its vulnerability count is deduplicated by image — see `getScannedTotals` —
 * which is the number a remediation acts on.
 */
export function ContainerGroupRow({
    group,
    isExpanded,
    onToggle,
}: {
    group: ContainerGroup;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    return (
        <TableRow hoverable aria-level={1} aria-expanded={isExpanded} className="bg-surface-hover/60">
            <TableCell className="align-middle">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.label}`}
                        onClick={onToggle}
                        className="cursor-pointer rounded-sm p-0.5 hover:bg-btn-secondary-hover"
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={`size-4 text-ink-secondary transition-transform duration-100 ${
                                isExpanded ? 'rotate-90' : ''
                            }`}
                        />
                    </button>

                    <div className="flex min-w-0 items-center gap-2">
                        {/* Semibold is what marks structure everywhere else —
                            table headers, the current sidebar item — and it is
                            what separates this row from the container rows at a
                            glance, since the tinted fill alone is faint. */}
                        <span className="truncate font-semibold text-ink" title={group.label}>
                            {group.label}
                        </span>
                    </div>

                    {/* `shrink-0 whitespace-nowrap`: squeezed columns truncate
                        the group label; they must not fold this count onto two
                        lines. */}
                    <Badge variant="neutral" className="shrink-0 whitespace-nowrap">
                        {group.containers.length} {group.containers.length === 1 ? 'container' : 'containers'}
                    </Badge>
                </div>
            </TableCell>

            {/* Empty, not "—": a namespace has no image and no scan date, and
                a dash there reads as "unknown", which is a different claim.
                One cell per column, not a `colSpan` across image + checked —
                Image and Checked both collapse below `md`, and a span
                across a sometimes-hidden column would shift every cell after
                it. Same breakpoints as the header on the cluster tab. */}
            <TableCell hideBelow="md" className="align-middle" />
            {/* Image owner */}
            <TableCell hideBelow="xl" className="align-middle" />

            <TableCell hideBelow="md" className="align-middle" />

            <TableCell align="end" className="whitespace-nowrap align-middle">
                {/* The group's own total: the sum of its distinct images'
                    totals, which since ADR 0007 is the same number the server
                    would compute — a sum composes. Colour is the worst image's
                    band, because the total answers "how much" and colour
                    answers "how urgent". */}
                <TotalRiskChip
                    score={group.risk}
                    band={group.riskBand ?? undefined}
                    title={
                        group.risk == null
                            ? 'Nothing in this group has been scanned'
                            : `Radar Score ${Math.round(group.risk).toLocaleString()} across this group's scanned images`
                    }
                />
            </TableCell>

            <TableCell align="end" className="whitespace-nowrap align-middle">
                {/* Null when no image under this group has been scanned. A
                    namespace of thirty unscanned containers used to render four
                    zero squares here, which reads as "clean" from across the
                    room. */}
                <ContainerSeverityCell vulnerabilities={group.vulnerabilities} aggregated />
            </TableCell>
        </TableRow>
    );
}
