/**
 * The radar that runs while a freshly-installed scanner has yet to report.
 *
 * This is the one screen in onboarding with nothing on it: the wizard has just
 * closed, the Helm command has run, and the control plane knows only that a
 * cluster exists. The gap to the first inventory report is short — a minute or
 * two — but a static "no containers yet" page during it is indistinguishable
 * from a broken install, which is exactly the moment a new user decides whether
 * the product works. A sweep that is visibly *doing* something says the page is
 * still watching, without claiming progress the server cannot measure.
 *
 * Deliberately not a spinner: a spinner means "this request is in flight" and
 * belongs to a wait measured in hundreds of milliseconds. This wait is measured
 * in minutes and is not a request at all — it is the page listening while
 * something happens in the user's own cluster. The radar reads as listening,
 * and the blips lighting up under the sweep are the shape of the thing being
 * waited for.
 *
 * Motion is all CSS (see the `radar-*` keyframes in `globals.css`), so it costs
 * nothing to leave running for the whole wait, and it holds still under
 * `prefers-reduced-motion`.
 */

/**
 * Where the blips sit: `angle` is clockwise from the top, `distance` is the
 * percentage down from the top edge of the dial that puts the dot on its ring.
 *
 * The delay is derived from the angle rather than hand-tuned, because the sweep
 * takes 4s for a full turn — so a blip at A degrees is passed at `A / 90`
 * seconds, and each one lights up under the leading edge instead of near it.
 */
const BLIPS = [
    { angle: 58, distance: 26 },
    { angle: 168, distance: 12 },
    { angle: 292, distance: 32 },
] as const;

export function WaitingForFirstData({ className = '' }: { className?: string }) {
    return (
        <div
            className={`relative mx-auto size-28 ${className}`}
            role="status"
            aria-label="Waiting for the first containers to be reported"
        >
            {/* The dial. `overflow-hidden` is what keeps the sweep and the
                expanding rings inside the circle — both are square elements
                clipped by this one. */}
            <div className="absolute inset-0 overflow-hidden rounded-full bg-surface-muted ring-1 ring-edge">
                {/* Rings expanding out of the centre, offset by half the period
                    so there is always one mid-flight. */}
                <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full border border-accent-emphasis animate-radar-ring"
                />
                <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full border border-accent-emphasis animate-radar-ring"
                    style={{ animationDelay: '2s' }}
                />

                {/* The sweep. The gradient is brightest at 0° with its tail
                    running back counter-clockwise, so under a clockwise
                    rotation the tail follows the leading edge rather than
                    running ahead of it. */}
                <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full animate-radar-sweep"
                    style={{
                        background:
                            'conic-gradient(from -70deg, transparent, color-mix(in oklab, var(--accent) 32%, transparent) 70deg, transparent 71deg)',
                    }}
                />

                {/* Static graticule — two rings and a crosshair, so the dial
                    still reads as a dial in the frames where the sweep is on
                    the far side. */}
                <span aria-hidden="true" className="absolute inset-[22%] rounded-full ring-1 ring-edge" />
                <span aria-hidden="true" className="absolute inset-[38%] rounded-full ring-1 ring-edge" />
                <span aria-hidden="true" className="absolute top-1/2 left-0 w-full border-t border-edge" />
                <span aria-hidden="true" className="absolute left-1/2 top-0 h-full border-l border-edge" />

                {BLIPS.map(({ angle, distance }) => (
                    <span
                        key={angle}
                        aria-hidden="true"
                        className="absolute inset-0"
                        style={{ transform: `rotate(${angle}deg)` }}
                    >
                        {/* `-ml-[3px]` is half of `size-1.5`, doing the job
                            `-translate-x-1/2` would: the flash keyframe owns
                            `transform`, so a translate here would be thrown
                            away for the duration of every flash. */}
                        <span
                            className="absolute left-1/2 -ml-[3px] size-1.5 rounded-full bg-accent-emphasis animate-radar-blip"
                            style={{ top: `${distance}%`, animationDelay: `${angle / 90}s` }}
                        />
                    </span>
                ))}

                {/* The cluster itself, at the origin. */}
                <span
                    aria-hidden="true"
                    className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-emphasis ring-2 ring-surface-muted"
                />
            </div>
        </div>
    );
}
