import { SiNpm, SiPypi, SiGo, SiRuby, SiRust, SiNuget, SiPhp, SiSwift, SiDart, SiElixir, SiCocoapods } from 'react-icons/si'
import { FaJava } from 'react-icons/fa'
import { Box } from 'lucide-react'

const PACKAGE_TYPE_META: Record<string, { icon: React.ReactNode; label: string }> = {
    'npm':            { icon: <SiNpm className="w-2.5 h-2.5" />,       label: 'npm' },
    'python':         { icon: <SiPypi className="w-2.5 h-2.5" />,      label: 'Python' },
    'go-module':      { icon: <SiGo className="w-2.5 h-2.5" />,        label: 'Go' },
    'gem':            { icon: <SiRuby className="w-2.5 h-2.5" />,      label: 'Ruby' },
    'rust-crate':     { icon: <SiRust className="w-2.5 h-2.5" />,      label: 'Rust' },
    'java-archive':   { icon: <FaJava className="w-2.5 h-2.5" />,      label: 'Java' },
    'dotnet':         { icon: <SiNuget className="w-2.5 h-2.5" />,     label: '.NET' },
    'php-composer':   { icon: <SiPhp className="w-2.5 h-2.5" />,       label: 'PHP' },
    'swift':          { icon: <SiSwift className="w-2.5 h-2.5" />,     label: 'Swift' },
    'dart-pub':       { icon: <SiDart className="w-2.5 h-2.5" />,      label: 'Dart' },
    'hex':            { icon: <SiElixir className="w-2.5 h-2.5" />,    label: 'Elixir' },
    'cocoapods':      { icon: <SiCocoapods className="w-2.5 h-2.5" />, label: 'CocoaPods' },
}

export function PackageTypeBadge({ packageType }: { packageType: string }) {
    const meta = PACKAGE_TYPE_META[packageType]
    if (meta) {
        return (
            <span className="inline-flex items-center gap-1.5 px-1 py-px text-xs text-ink-muted shrink-0" title={packageType}>
                {meta.icon}
                <span>{meta.label}</span>
            </span>
        )
    }
    return (
        <span className="inline-flex items-center gap-0.5 px-1 py-px text-xs text-ink-muted shrink-0" title={packageType}>
            <Box className="w-2.5 h-2.5" />
            <span>{packageType}</span>
        </span>
    )
}
