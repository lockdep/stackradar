import { Container, Server } from 'lucide-react';
import { SiDocker, SiHelm } from 'react-icons/si';

/**
 * The four things a reader meets by name all over the app, each with one
 * glyph: a container image (Docker whale), a Helm chart or release (Helm
 * ship's wheel), a running container (lucide's shipping container), a
 * cluster (server).
 *
 * One vocabulary because the names alone do not tell them apart — `nginx`
 * is an image, a chart and a Deployment — and before this the same image was
 * drawn as a stack, a box, a shipping container and a whale depending on the
 * page. The glyph goes in front of the name wherever the name appears, so a
 * reader learns the marks once and reads every table by them.
 *
 * Brand marks for image and chart rather than lucide's generic boxes so they
 * do not blur into each other at 14px, and so none of them collides with the
 * sidebar's `Boxes` (Packages) or `Package` (lucide's parcel, which used to
 * mean "chart" here and looked like a package). The container is the one
 * lucide glyph: the Kubernetes helm it replaced (2026-09-13) read as
 * "cluster" next to the Server mark, and the shipping container is the
 * literal reading of the word.
 *
 * Two icon libraries on purpose: lucide has no brand marks, and `react-icons`
 * carries the Docker and Helm ones; every `react-icons` import names its pack
 * (`react-icons/si`, never the root), so only the glyphs used are bundled.
 *
 * Decorative by default (`aria-hidden`): every call site sits under a column
 * header or heading that names the type. Pass `label` where the icon is the
 * only marker — a mixed list — and it gets screen-reader text.
 */
export type EntityKind = 'image' | 'chart' | 'container' | 'cluster';

const GLYPH = {
    image: SiDocker,
    chart: SiHelm,
    container: Container,
    cluster: Server,
} as const;

const LABEL: Record<EntityKind, string> = {
    image: 'Container image',
    chart: 'Helm chart',
    container: 'Running container',
    cluster: 'Cluster',
};

export function EntityIcon({
    kind,
    label = false,
    className = 'size-3.5 text-ink-muted',
}: {
    kind: EntityKind;
    /** `true` for the default name, a string to say something more specific. */
    label?: boolean | string;
    className?: string;
}) {
    const Glyph = GLYPH[kind];
    return (
        <>
            <Glyph aria-hidden="true" className={`shrink-0 ${className}`} />
            {label && <span className="sr-only">{label === true ? LABEL[kind] : label}</span>}
        </>
    );
}
