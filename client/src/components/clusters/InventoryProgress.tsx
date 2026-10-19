'use client';

/**
 * "47 containers discovered · 6 scanned · 41 generating SBOMs".
 *
 * The one honest wait in onboarding is image pull plus SBOM generation, and it
 * is the wait the UI used to hide completely: the informer knows every workload
 * within seconds of starting, but a container only counts as scanned once its
 * image has an SBOM — so "scanner connected" to "first result" was a blank
 * screen. Naming the denominator converts that dead time into visible progress,
 * and watching your own cluster inventory appear is itself proof the product
 * works.
 *
 * Both numbers come from one `LEFT JOIN` over `workload_containers`, so
 * `scanned <= discovered` holds by construction. It did not always: `scanned`
 * used to be a bare count of `projects`, which outlived the workloads they
 * described, and the difference was clamped away rather than fixed.
 */
export function InventoryProgress({
    discovered,
    scanned,
    blocked = 0,
    failed = 0,
}: {
    discovered: number;
    scanned: number;
    /**
     * Containers whose scan the registry rejected. They are not "generating
     * SBOMs" and never will be until someone acts, so the line says so
     * instead of counting them as progress that is merely slow.
     */
    blocked?: number;
    /** Containers whose scan failed for any other reported reason. */
    failed?: number;
}) {
    if (discovered <= 0) return null;

    const pending = Math.max(0, discovered - scanned - blocked - failed);
    const pct = Math.round((scanned / discovered) * 100);

    /* Complete is a sentence, not a permanently-full progress bar. The bar
       measures a wait; once there is no wait left it is decoration, but the
       count still earns its place — "we looked at all of it" is the claim the
       whole product rests on. */
    if (pending <= 0) {
        return (
            <p className="text-xs text-ink-muted">
                All {discovered.toLocaleString()} discovered container{discovered === 1 ? '' : 's'} scanned
            </p>
        );
    }

    return (
        <div className="space-y-1.5">
            <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={discovered}
                aria-valuenow={scanned}
                aria-label={`${scanned} of ${discovered} discovered containers scanned`}
                className="h-1 w-full overflow-hidden rounded-full bg-surface-muted"
            >
                <div
                    className="h-full rounded-full bg-accent-emphasis transition-all duration-500"
                    style={{ width: `${pct}%` }}
                />
            </div>
            <p className="text-xs text-ink-muted">
                {discovered.toLocaleString()} container{discovered === 1 ? '' : 's'} discovered
                {' · '}
                {scanned.toLocaleString()} scanned
                {blocked > 0 && (
                    <>
                        {' · '}
                        <span className="text-danger">{blocked.toLocaleString()} blocked on registry credentials</span>
                    </>
                )}
                {failed > 0 && (
                    <>
                        {' · '}
                        <span className="text-attention">{failed.toLocaleString()} failing</span>
                    </>
                )}
                {pending > 0 && (
                    <>
                        {' · '}
                        {pending.toLocaleString()} generating SBOMs
                    </>
                )}
            </p>
        </div>
    );
}
