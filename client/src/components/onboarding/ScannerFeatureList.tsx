import { ScanSearch, ShieldAlert, Workflow } from 'lucide-react'

/**
 * The scanner's three-line pitch — shared verbatim by the onboarding gate and
 * the Clusters view's empty state, which are the two places a user without a
 * cluster can land.
 */
export function ScannerFeatureList() {
    return (
        <ul className="mt-6 inline-flex flex-col gap-2 text-left text-sm text-ink-muted">
            <li className="flex items-center gap-2">
                <Workflow className="size-4 text-success shrink-0" />
                Auto-discover running containers across namespaces
            </li>
            <li className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-success shrink-0" />
                Track vulnerabilities per image
            </li>
            <li className="flex items-center gap-2">
                <ScanSearch className="size-4 text-success shrink-0" />
                Continuous SBOM generation, no CI changes needed
            </li>
        </ul>
    )
}
