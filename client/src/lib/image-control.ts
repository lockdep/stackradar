/**
 * Who controls an image — the client's vocabulary for `images.control`.
 *
 * The server derives it per repository (`server/src/lib/image-control.ts`)
 * and an org corrects it once. "control", "built" and "unknown" are the API's
 * words and stay out of copy: the UI says "Yours", "Third-party", "In your
 * control", "Waiting on upstream".
 */

export type ImageControl = 'built' | 'third-party' | 'unknown'

export type ControlSignal =
    | 'rule'
    | 'chart'
    | 'official-image'
    | 'private-registry'
    | 'known-image'
    | 'built-on-known'
    | 'public-registry'

export const CONTROL_LABEL: Record<ImageControl, string> = {
    built: 'Yours',
    'third-party': 'Third-party',
    unknown: 'Unconfirmed',
}

/** Why we think so — the muted reason beside a repository. */
export function controlReason(detectedBy: ControlSignal | null, detail: string | null): string {
    switch (detectedBy) {
        case 'rule': return 'set by your organization'
        case 'chart': return detail ? `delivered by chart ${detail}` : 'delivered by a public chart'
        case 'official-image': return 'Docker Official Image'
        case 'private-registry': return 'private registry'
        case 'known-image': return 'identical to a public image'
        case 'built-on-known': return 'your own layers on top of a public image'
        case 'public-registry': return detail ? `public vendor registry (${detail})` : 'public vendor registry'
        default: return 'could not tell'
    }
}

/** One row of `GET /api/organizations/:id/image-control`. */
export interface RepositoryControl {
    registry: string
    repository: string
    control: ImageControl
    detected: { control: ImageControl; detectedBy: ControlSignal | null; detail: string | null }
    rule: { control: Exclude<ImageControl, 'unknown'>; reason: string | null; createdByEmail: string | null; updatedAt: string } | null
    source: string | null
    imageCount: number
    containerCount: number
}

export interface ImageControlResponse {
    repositories: RepositoryControl[]
    unknownCount: number
}

export const repositoryKey = (r: { registry: string; repository: string }) => `${r.registry}/${r.repository}`

export type RuleChange = {
    registry: string
    repository: string
    /** Null resets the repository to what was detected. */
    control: 'built' | 'third-party' | null
}

/**
 * The rules one save writes, from the ticks on screen (`true` = "we build
 * this"). A repository left as it is in force writes nothing — except one
 * nothing had decided: leaving it unticked *is* the answer "not ours", and
 * without a row for it the question would be asked again.
 */
export function changesToSave(
    repositories: readonly RepositoryControl[],
    ticked: ReadonlyMap<string, boolean>
): RuleChange[] {
    const changes: RuleChange[] = []
    for (const repo of repositories) {
        const key = repositoryKey(repo)
        const built = ticked.get(key) ?? repo.control === 'built'
        const wanted: 'built' | 'third-party' = built ? 'built' : 'third-party'
        if (repo.control === wanted) continue
        // Back to what was detected: drop the rule rather than restate it.
        const control = repo.rule && repo.detected.control === wanted ? null : wanted
        changes.push({ registry: repo.registry, repository: repo.repository, control })
    }
    return changes
}

// ─── The Dashboard banner's dismissal ─────────────────────────────────────────

const dismissalKey = (orgId: string) => `sr.image-ownership-dismissed:${orgId}`

/** The unconfirmed repositories the reader has already waved away. */
export function readDismissed(orgId: string): Set<string> {
    try {
        const raw = window.localStorage.getItem(dismissalKey(orgId))
        const parsed: unknown = raw ? JSON.parse(raw) : []
        return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [])
    } catch {
        return new Set()
    }
}

export function storeDismissed(orgId: string, keys: Iterable<string>): void {
    try {
        window.localStorage.setItem(dismissalKey(orgId), JSON.stringify([...keys]))
    } catch {
        /* A card that comes back is a nuisance, not a failure. */
    }
}

/**
 * Whether the card has something new to ask: an unconfirmed repository the
 * reader has not dismissed. Never asks about the same repository twice.
 */
export function hasUnaskedRepositories(repositories: readonly RepositoryControl[], dismissed: ReadonlySet<string>): boolean {
    return repositories.some(r => r.control === 'unknown' && !dismissed.has(repositoryKey(r)))
}

/**
 * The image page's one line about whose image this is. Null while nothing
 * has decided: an unconfirmed image says nothing here,
 * the Dashboard banner is where that question is asked.
 */
export function controlHeadline(image: {
    control?: ImageControl | null | undefined
    controlDetectedBy?: ControlSignal | null | undefined
    controlDetail?: string | null | undefined
}): string | null {
    // What it is built on is the next line's to say (`baseImageLine`).
    if (image.control === 'built') return CONTROL_LABEL.built
    if (image.control === 'third-party') {
        const why =
            image.controlDetectedBy === 'chart' && image.controlDetail ? `delivered by chart ${image.controlDetail}`
            : image.controlDetectedBy === 'official-image' ? 'Docker Official Image'
            : image.controlDetectedBy === 'public-registry' && image.controlDetail ? image.controlDetail
            : image.controlDetectedBy === 'rule' ? 'set by your organization'
            : null
        return why ? `${CONTROL_LABEL['third-party']} · ${why}` : CONTROL_LABEL['third-party']
    }
    return null
}

/**
 * "Base image: `node:20-bookworm-slim` · 9 of 14 layers" — what is known
 * about where the base ends, and nothing when nothing is. `totalLayers` is
 * left out when the page does not have it.
 */
export function baseImageLine(
    image: { baseImageRef?: string | null | undefined; baseLayerCount?: number | null | undefined },
    totalLayers?: number | null
): { ref: string | null; layers: string | null } | null {
    const ref = image.baseImageRef ?? null
    const count = image.baseLayerCount ?? null
    if (ref === null && count === null) return null
    const layers =
        count === null ? null
        : totalLayers ? `${count} of ${totalLayers} layers`
        : ref === null ? `first ${count} ${count === 1 ? 'layer' : 'layers'}`
        : `${count} ${count === 1 ? 'layer' : 'layers'}`
    return { ref, layers }
}

// ─── "Yours / Third-party / All" — the lists' filter ────────────────────────

/** The page-URL and API value. `yours` includes the images nothing has decided. */
export type ControlFilter = 'yours' | 'third-party' | 'all'

export const CONTROL_FILTERS: readonly ControlFilter[] = ['yours', 'third-party', 'all']

export const CONTROL_FILTER_LABEL: Record<ControlFilter, string> = {
    yours: 'Yours',
    'third-party': 'Third-party',
    all: 'All',
}

export const CONTROL_FILTER_HINT: Record<ControlFilter, string> = {
    yours: 'Images your organization builds, and the ones it has not yet said anything about.',
    'third-party': 'Images someone else builds: their one recommended action is the upstream upgrade.',
    all: 'Every image.',
}

export const CONTROL_FILTER_PARAM = 'control'

export function isControlFilter(value: string | null | undefined): value is ControlFilter {
    return value != null && (CONTROL_FILTERS as readonly string[]).includes(value)
}

/** Which side of the filter an image is on. An unconfirmed image is yours until someone says otherwise. */
export function controlSide(control: ImageControl | null | undefined): Exclude<ControlFilter, 'all'> {
    return control === 'third-party' ? 'third-party' : 'yours'
}

export function matchesControlFilter(control: ImageControl | null | undefined, filter: ControlFilter): boolean {
    return filter === 'all' || controlSide(control) === filter
}

/** Counts for the three segments, from rows already in hand. */
export function controlFilterCounts(controls: readonly (ImageControl | null | undefined)[]): Record<ControlFilter, number> {
    const counts: Record<ControlFilter, number> = { yours: 0, 'third-party': 0, all: controls.length }
    for (const c of controls) counts[controlSide(c)] += 1
    return counts
}
