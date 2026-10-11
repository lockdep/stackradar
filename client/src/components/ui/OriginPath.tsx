import { ChevronRight } from 'lucide-react';

type PathSegment = { name: string; version: string | null };

type OriginPathProps = {
    isDirect: boolean;
    dependencyPath: PathSegment[] | null;
    location: string | null;
    componentName: string;
};

function buildFullPath(location: string | null, dependencyPath: PathSegment[], componentName: string): string {
    const parts: string[] = [];
    if (location) parts.push(location);
    for (const seg of dependencyPath) {
        parts.push(seg.version ? `${seg.name}@${seg.version}` : seg.name);
    }
    parts.push(componentName);
    return parts.join(' → ');
}

export function OriginPath({ isDirect, dependencyPath, location, componentName }: OriginPathProps) {
    const hasPath = !isDirect && dependencyPath && dependencyPath.length > 0;

    if (!hasPath && !location) {
        return <span className="text-ink-muted text-sm">—</span>;
    }

    if (!hasPath) {
        return (
            <span className="relative group/origin">
                <span
                    tabIndex={0}
                    title={location!}
                    className="inline-flex items-center gap-1 text-xs text-ink-muted rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                >
                    <span className="truncate font-mono max-w-[180px]">{location}</span>
                </span>
                <span
                    aria-hidden="true"
                    className="absolute bottom-full left-0 mb-2 px-2 py-1 text-xs font-medium text-surface bg-ink rounded-sm opacity-0 group-hover/origin:opacity-100 group-focus-within/origin:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50"
                >
                    {location}
                    <span className="absolute top-full left-4 border-4 border-transparent border-t-ink" />
                </span>
            </span>
        );
    }

    const path = dependencyPath!;
    const fullPath = buildFullPath(location, path, componentName);

    return (
        <span className="relative group/origin">
            <span
                tabIndex={0}
                title={fullPath}
                className="inline-flex items-center gap-0.5 text-xs text-ink-muted rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
            >
                {location && (
                    <>
                        <span className="font-mono text-ink-muted truncate max-w-[80px]">{location}</span>
                        <ChevronRight className="h-3 w-3 text-ink-muted shrink-0" />
                    </>
                )}
                <span className="font-mono text-accent font-medium truncate max-w-[80px]">{path[0].name}</span>
                {path.length > 2 && (
                    <>
                        <ChevronRight className="h-3 w-3 text-ink-faint shrink-0" />
                        <span className="text-ink-muted">…</span>
                    </>
                )}
                {path.length > 1 && (
                    <>
                        <ChevronRight className="h-3 w-3 text-ink-faint shrink-0" />
                        <span className="font-mono text-ink-muted truncate max-w-[80px]">
                            {path[path.length - 1].name}
                        </span>
                    </>
                )}
            </span>
            <span
                aria-hidden="true"
                className="absolute bottom-full left-0 mb-2 px-2 py-1.5 text-xs font-medium text-surface bg-ink rounded-sm opacity-0 group-hover/origin:opacity-100 group-focus-within/origin:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50"
            >
                {fullPath}
                <span className="absolute top-full left-4 border-4 border-transparent border-t-ink" />
            </span>
        </span>
    );
}
