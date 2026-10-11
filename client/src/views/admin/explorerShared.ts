import { useResource } from '@/hooks';
import type { ExplorerImage, ExplorerSbom } from './types';

/**
 * Short label for an SBOM in breadcrumbs and headers.
 *
 * The digest, short — not a tag. An SBOM has no tag any more: a tag is what a
 * deployment asked for and lives on `workload_containers`, while the SBOM
 * describes the bytes the digest names.
 */
export function sbomLabel(s: ExplorerSbom): string {
    const hex = s.digest.includes(':') ? s.digest.slice(s.digest.indexOf(':') + 1) : s.digest;
    return hex ? hex.slice(0, 12) : `${s.format.toUpperCase()} ${s.id.slice(0, 8)}`;
}

/** `repository@short-digest`, the shortest label that is still unambiguous. */
export function imageLabel(image: ExplorerImage): string {
    const name = image.repository ?? image.registry ?? 'image';
    const hex = image.digest.includes(':') ? image.digest.slice(image.digest.indexOf(':') + 1) : image.digest;
    return `${name}@${hex.slice(0, 12)}`;
}

// Generic fetch for the drill-down levels (not refreshKey-bound).
export function useExplorerFetch<T>(url: string | null) {
    return useResource<T>(url, { cache: 'no-store', loadingOnRefetch: true });
}
