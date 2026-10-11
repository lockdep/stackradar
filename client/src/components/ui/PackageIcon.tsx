import type { ComponentType } from 'react';
import { Package } from 'lucide-react';
import {
    SiAlpinelinux,
    SiAnaconda,
    SiApachemaven,
    SiCocoapods,
    SiComposer,
    SiConan,
    SiDart,
    SiDebian,
    SiDocker,
    SiElixir,
    SiGithub,
    SiGo,
    SiHaskell,
    SiNpm,
    SiNuget,
    SiPypi,
    SiR,
    SiRedhat,
    SiRubygems,
    SiRust,
    SiSwift,
} from 'react-icons/si';

/**
 * The ecosystem mark for a package, keyed by the **purl type** — the
 * scheme-level word of `pkg:npm/lodash@4.17.21`, which is the identifier the
 * server carries on a package row. `PackageTypeBadge` does the same job for
 * syft's package-type vocabulary (`java-archive`, `python`, …); the two
 * spellings come from different layers and neither maps cleanly onto the
 * other, so each keeps its own table. Anything without a brand mark falls
 * back to lucide's parcel, so a row always has one glyph in the same slot.
 *
 * Decorative (`aria-hidden`): every call site prints the type in words next
 * to it.
 */
type Glyph = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;

const GLYPH: Record<string, Glyph> = {
    npm: SiNpm,
    maven: SiApachemaven,
    gradle: SiApachemaven,
    pypi: SiPypi,
    conda: SiAnaconda,
    golang: SiGo,
    cargo: SiRust,
    gem: SiRubygems,
    nuget: SiNuget,
    composer: SiComposer,
    deb: SiDebian,
    apk: SiAlpinelinux,
    rpm: SiRedhat,
    swift: SiSwift,
    cocoapods: SiCocoapods,
    pub: SiDart,
    hex: SiElixir,
    hackage: SiHaskell,
    conan: SiConan,
    cran: SiR,
    github: SiGithub,
    docker: SiDocker,
    oci: SiDocker,
};

export function PackageIcon({
    purlType,
    className = 'size-4 text-ink-muted',
}: {
    purlType: string | null | undefined;
    className?: string;
}) {
    const Glyph = (purlType && GLYPH[purlType.toLowerCase()]) || Package;
    return <Glyph aria-hidden="true" className={`shrink-0 ${className}`} />;
}
