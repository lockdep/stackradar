export function formatDate(dateString: string | null | undefined): string {
    if (!dateString) return '—'
    const date = new Date(dateString)
    const day = date.getDate()
    const month = date.toLocaleString('en-US', { month: 'short' })
    const year = date.getFullYear()
    const time = date.toLocaleString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: false 
    })
    return `${day} ${month} ${year} at ${time}`
}

/**
 * Date without the time — for narrow table columns where the full
 * `formatDate` string would overflow. Put the full form in a `title`.
 */
export function formatShortDate(dateString: string | null | undefined): string {
    if (!dateString) return '—'
    const date = new Date(dateString)
    const month = date.toLocaleString('en-US', { month: 'short' })
    return `${date.getDate()} ${month} ${date.getFullYear()}`
}

/**
 * Short relative timestamp — "5m ago". Null means the event never happened
 * ("Never"), which only the admin surfaces currently pass. For the long
 * spelled-out form ("5 minutes ago") see `formatRelativeTime`.
 */
export function formatTimeAgo(date: Date | string | null | undefined): string {
    if (!date) return 'Never'
    const time = typeof date === 'string' ? new Date(date).getTime() : date.getTime()
    const seconds = Math.floor((Date.now() - time) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

/**
 * A span in milliseconds — "340ms", "45s", "3m 20s". Null means "no span to
 * report" (a run that never completed) and renders a dash.
 */
export function formatDuration(ms: number | null): string {
    if (ms == null) return '—'
    if (ms < 1000) return `${ms}ms`
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Extract the image name (registry + repository) from a full image ref,
 * stripping any tag and/or digest. The tag is shown separately as "Version".
 *
 * Examples:
 *   docker.io/library/nginx:1.25 → docker.io/library/nginx
 *   ghcr.io/foo/bar@sha256:abc   → ghcr.io/foo/bar
 *   foo/bar:1.2.3@sha256:abc     → foo/bar
 */
export function formatImageName(imageRef: string | null | undefined): string | null {
    if (!imageRef) return null
    let ref = imageRef
    const digestIdx = ref.indexOf('@')
    if (digestIdx !== -1) ref = ref.slice(0, digestIdx)
    const lastSlash = ref.lastIndexOf('/')
    const colonIdx = ref.indexOf(':', lastSlash + 1)
    if (colonIdx !== -1) ref = ref.slice(0, colonIdx)
    return ref
}

/**
 * Short form of an image digest — `sha256:` plus the first 12 hex characters,
 * the same prefix length docker and crictl print.
 */
export function formatShortDigest(imageDigest: string | null | undefined): string | null {
    if (!imageDigest) return null
    return imageDigest.slice(0, 19)
}

/**
 * A "tag" that is actually a digest: 64 hex characters, with or without the
 * `sha256:` prefix. Old scanner versions recorded containerd's bare image ID
 * (`sha256:<config hash>`) as a tag for digest-pinned pods, and some CD
 * pipelines genuinely tag images with a digest hex — either way it reads as
 * a digest and deserves a digest's 12-character rendering, not 64.
 */
export function isDigestLikeTag(tag: string): boolean {
    return /^(sha256:)?[a-f0-9]{64}$/i.test(tag)
}

/**
 * How an image names itself on screen: its tag when it has one, otherwise its
 * short digest.
 *
 * A digest-pinned deployment (Flux/Argo image automation, Kustomize
 * `images[].digest`) genuinely has no tag, so `imageTag` is null and the digest
 * is the only honest label. A digest-like tag (see `isDigestLikeTag`) is
 * shortened the same way. Never fall back to a CycloneDX `documentVersion`
 * here — that is a document revision counter, not a name for this image.
 */
export function formatImageTag(
    imageTag: string | null | undefined,
    imageDigest: string | null | undefined,
): string | null {
    const tag = imageTag?.trim()
    if (tag && !isDigestLikeTag(tag)) return tag
    // Digest-like tag or no tag at all: the image's real digest is the better
    // label when we have it — a recorded bare image ID is a config hash, not
    // anything pullable — with the tag's own hex as the last resort.
    if (imageDigest) return formatShortDigest(imageDigest)
    if (tag) return formatShortDigest(tag.startsWith('sha256:') ? tag : `sha256:${tag}`)
    return null
}

/**
 * How long ago, the way `kubectl` and Lens write a pod's age: `40m`, `3h33m`,
 * `12d`, `2y45d`. Empty for no date.
 */
export function formatAge(dateString: string | null | undefined): string {
    if (!dateString) return ''
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(dateString).getTime()) / 60_000))
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 365) return `${days}d`
    return days % 365 ? `${Math.floor(days / 365)}y${days % 365}d` : `${Math.floor(days / 365)}y`
}

export function formatRelativeTime(dateString: string | null | undefined): string {
    if (!dateString) return ''
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSeconds = Math.floor(diffMs / 1000)
    const diffMinutes = Math.floor(diffSeconds / 60)
    const diffHours = Math.floor(diffMinutes / 60)
    const diffDays = Math.floor(diffHours / 24)
    const diffWeeks = Math.floor(diffDays / 7)
    const diffMonths = Math.floor(diffDays / 30)

    if (diffSeconds < 60) return 'just now'
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
    if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`
    if (diffDays < 365) return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`
    const diffYears = Math.floor(diffDays / 365)
    return `${diffYears} year${diffYears === 1 ? '' : 's'} ago`
}

