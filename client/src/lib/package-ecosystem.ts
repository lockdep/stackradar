/**
 * `?ecosystem=` on the package lists: a purl type (`npm`, `golang`), or a type
 * and its distro for OS packages (`deb/ubuntu`). The values are the server's
 * (`GET …/components/ecosystems`) — whatever the scanned purls carry — so
 * this file only names them; one it has no name for shows as it is spelled.
 */
export const ECOSYSTEM_PARAM = 'ecosystem'

/** The menu's "no filter" value; never a purl type. */
export const ALL_ECOSYSTEMS = 'all'

const TYPE_LABEL: Record<string, string> = {
    npm: 'npm',
    golang: 'Go',
    pypi: 'Python',
    maven: 'Java',
    gem: 'Ruby',
    cargo: 'Rust',
    nuget: '.NET',
    composer: 'PHP',
    swift: 'Swift',
    pub: 'Dart',
    hex: 'Elixir',
    cocoapods: 'CocoaPods',
    generic: 'Generic',
}

const DISTRO_LABEL: Record<string, string> = {
    ubuntu: 'Ubuntu',
    debian: 'Debian',
    alpine: 'Alpine',
    wolfi: 'Wolfi',
    chainguard: 'Chainguard',
    redhat: 'Red Hat',
    centos: 'CentOS',
    fedora: 'Fedora',
    rocky: 'Rocky Linux',
    almalinux: 'AlmaLinux',
    amzn: 'Amazon Linux',
    ol: 'Oracle Linux',
    sles: 'SLES',
    opensuse: 'openSUSE',
    photon: 'Photon OS',
    azurelinux: 'Azure Linux',
}

export function ecosystemLabel(ecosystem: string): string {
    const [type = '', distro] = ecosystem.split('/')
    if (distro) return `${DISTRO_LABEL[distro] ?? distro} (${type})`
    return TYPE_LABEL[type] ?? type
}
