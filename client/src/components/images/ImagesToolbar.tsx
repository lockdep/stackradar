'use client';

import {
    EntityIcon,
    FilterBar,
    FilterBarEnd,
    FilterBarRefresh,
    FilterBarReset,
    ImagesFilterMenu,
    ScopeFilterMenu,
    SearchInput,
} from '@/components/ui';
import type { ControlFilter } from '@/lib/image-control';

type ScopeOption = { value: string; label: string };

type Props = {
    /** No images at all: the bar keeps its refresh and drops the rest — nothing to search or scope. */
    hasImages: boolean;
    refresh: { onRefresh: () => void; isRefreshing: boolean };
    search: { value: string; onChange: (value: string) => void };
    /** Present when something is set that a fresh link would not carry. */
    onReset: (() => void) | null;
    /* Cluster, then namespace, then registry, each menu listing what the
       scope before it leaves — the containers list's order. */
    scope: {
        clusterId: string | null;
        clusterOptions: ScopeOption[];
        onClusterChange: (id: string | null) => void;
        namespace: string | null;
        namespaceOptions: ScopeOption[];
        onNamespaceChange: (name: string | null) => void;
        registry: string | null;
        registryOptions: ScopeOption[];
        onRegistryChange: (registry: string | null) => void;
    };
    control: {
        value: ControlFilter;
        onChange: (next: ControlFilter) => void;
        counts: Record<ControlFilter, number>;
        canManage: boolean;
    };
};

/**
 * The `/images` header and filter bar. Stateless: sort and scope live in the
 * URL through the containers list's hook, search in the view — the bar only
 * draws and relays them, so the two fleet lists cannot grow different bars.
 */
export function ImagesToolbar({ hasImages, refresh, search, onReset, scope, control }: Props) {
    return (
        <>
            <header className="pb-4">
                <h1 className="text-xl font-semibold text-ink">Images</h1>
                <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                    Every image running in your clusters, worst first. One row per image, however many containers run
                    it; the same image in two clusters is listed once for each.
                </p>
            </header>

            <FilterBar label="Image filters — apply to the whole list">
                <FilterBarRefresh
                    onRefresh={refresh.onRefresh}
                    isRefreshing={refresh.isRefreshing}
                    label="Refresh images"
                />
                {hasImages && (
                    <>
                        <SearchInput
                            id="image-search"
                            label="Search images"
                            placeholder="Search images"
                            value={search.value}
                            onChange={search.onChange}
                            className="w-full sm:w-64"
                        />
                        <FilterBarEnd>
                            {onReset && <FilterBarReset onReset={onReset} />}
                            <ScopeFilterMenu
                                label="Cluster"
                                allLabel="All clusters"
                                icon={<EntityIcon kind="cluster" className="size-4" />}
                                scope={{
                                    value: scope.clusterId,
                                    options: scope.clusterOptions,
                                    onChange: scope.onClusterChange,
                                }}
                            />
                            {scope.namespaceOptions.length > 0 && (
                                <ScopeFilterMenu
                                    label="Namespace"
                                    allLabel="All namespaces"
                                    scope={{
                                        value: scope.namespace,
                                        options: scope.namespaceOptions,
                                        onChange: scope.onNamespaceChange,
                                    }}
                                />
                            )}
                            {scope.registryOptions.length > 0 && (
                                <ScopeFilterMenu
                                    label="Registry"
                                    allLabel="All registries"
                                    scope={{
                                        value: scope.registry,
                                        options: scope.registryOptions,
                                        onChange: scope.onRegistryChange,
                                    }}
                                />
                            )}
                            <ImagesFilterMenu
                                value={control.value}
                                onChange={control.onChange}
                                counts={control.counts}
                                canManageImages={control.canManage}
                            />
                        </FilterBarEnd>
                    </>
                )}
            </FilterBar>
        </>
    );
}

/** The line over the table: the order, and how many rows and containers the filters left. */
export function ImagesCaption({
    narrowed,
    imageCount,
    containerCount,
}: {
    narrowed: boolean;
    imageCount: number;
    containerCount: number;
}) {
    return (
        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-edge pb-3">
            <p className="text-xs text-ink-muted">
                <span className="font-medium text-ink-secondary">Worst first</span>
                <span className="mx-1.5 text-ink-faint">·</span>
                Every running image in the organisation, by Risk Score.
            </p>
            <p className="whitespace-nowrap text-xs text-ink-muted">
                {narrowed && <span>Matching: </span>}
                {plural(imageCount, 'image')}
                <span className="mx-1.5 text-ink-faint">·</span>
                {plural(containerCount, 'container')}
            </p>
        </div>
    );
}

/** A scope menu's options: the distinct values, sorted, plus the chosen one if the rows no longer carry it. */
export function scopeOptions(values: string[], chosen: string | null): { value: string; label: string }[] {
    const distinct = new Set(values);
    if (chosen !== null) distinct.add(chosen);
    return [...distinct].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
}

function plural(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}
