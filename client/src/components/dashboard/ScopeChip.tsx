import { CONTROL_FILTER_IMAGES_LABEL, type ControlFilter } from '@/lib/image-control';
import { TIER_LENS_FINDINGS_LABEL, type TierLens } from '@/lib/tier-lens';

/** The chip's hover text — and how a test finds the chip, since the text itself is the filters'. */
export const SCOPE_CHIP_TITLE = 'Which findings and images this block counts — set in the filter bar above';

/**
 * "Application findings · all images" — the two filters a block counts under,
 * in the words of the filter bar's menus. Plain "All findings" when neither
 * narrows anything: there is nothing to warn about. With a cluster or
 * namespace scope in force, "· in platform-eu1 / argocd" follows
 * (`scopeWords` in `dashboard-scope.ts`): where is the third thing a count
 * is under, and the one most often forgotten when two numbers are compared.
 */
export function scopeChipLabel(lens: TierLens, control: ControlFilter, where?: string | null): string {
    const findings = TIER_LENS_FINDINGS_LABEL[lens];
    const images = CONTROL_FILTER_IMAGES_LABEL[control];
    const filters =
        lens === 'all' && control === 'all'
            ? findings
            : `${findings} · ${images.charAt(0).toLowerCase()}${images.slice(1)}`;
    return where ? `${filters} · in ${where}` : filters;
}

/**
 * The page's lens and image scope, repeated on every block that counts
 * under them. The filter bar sets both once for the whole page, but a
 * reader comparing the exposure strip's 262 critical with a cluster row's
 * 359 is not looking at the bar — the chip puts the answer in the header of
 * each block, the same words in both places, so a difference between two
 * numbers is never a difference in what was counted.
 */
export function ScopeChip({
    lens,
    control,
    where,
    className = '',
}: {
    lens: TierLens;
    control: ControlFilter;
    /** The cluster / namespace scope in words (`scopeWords`); absent or null when the page is organization-wide. */
    where?: string | null;
    className?: string;
}) {
    return (
        <span
            title={SCOPE_CHIP_TITLE}
            className={`inline-flex items-center rounded-full border border-edge bg-surface-muted px-2 py-0.5 text-xs font-normal whitespace-nowrap text-ink-muted ${className}`}
        >
            {scopeChipLabel(lens, control, where)}
        </span>
    );
}
