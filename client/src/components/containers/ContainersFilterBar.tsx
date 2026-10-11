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
    type ScopeFilter,
} from '@/components/ui';
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import type { ControlFilter } from '@/lib/image-control';

/**
 * The containers lists' filter line (`ui/FilterBar`), shared by the org-wide
 * `/containers` page and the cluster tab: refresh and search on the left —
 * *which rows* — and the scope on the right, widest first: cluster,
 * namespace, whose images. The cluster tab passes neither scope; it is one
 * cluster, folded by namespace.
 *
 * No unscanned control: that filter's one home is the coverage strip below,
 * which states the number as well as offering the toggle, and a second
 * control for it would be two places to read one answer.
 */
export function ContainersFilterBar({
    onRefresh,
    isRefreshing,
    search,
    cluster,
    namespace,
    control,
    onControlChange,
    controlCounts,
    onReset,
}: {
    onRefresh: () => void;
    isRefreshing: boolean;
    /** Absent while there is nothing to search: the bar is then the refresh alone. */
    search?: { value: string; onChange: (value: string) => void } | undefined;
    cluster?: ScopeFilter | undefined;
    namespace?: ScopeFilter | undefined;
    control: ControlFilter;
    onControlChange: (next: ControlFilter) => void;
    /** What each choice would list, inside the cluster and namespace scope. */
    controlCounts: Record<ControlFilter, number>;
    /** Present when something is narrowed — the page knows what a fresh link lacks. */
    onReset?: (() => void) | undefined;
}) {
    const { organization } = useOrganization();
    const { demoMode } = useRuntimeConfig();

    return (
        <FilterBar label="Container filters — apply to the whole list">
            <FilterBarRefresh onRefresh={onRefresh} isRefreshing={isRefreshing} label="Refresh containers" />
            {search && (
                <>
                    <SearchInput
                        id="container-search"
                        label="Search containers"
                        placeholder="Search containers"
                        value={search.value}
                        onChange={search.onChange}
                        className="w-full sm:w-64"
                    />
                    <FilterBarEnd>
                        {onReset && <FilterBarReset onReset={onReset} />}
                        {cluster && (
                            <ScopeFilterMenu
                                label="Cluster"
                                allLabel="All clusters"
                                icon={<EntityIcon kind="cluster" className="size-4" />}
                                scope={cluster}
                            />
                        )}
                        {namespace && <ScopeFilterMenu label="Namespace" allLabel="All namespaces" scope={namespace} />}
                        <ImagesFilterMenu
                            value={control}
                            onChange={onControlChange}
                            counts={controlCounts}
                            /* The tab's own gate: owners and admins, and the demo's read-only view. */
                            canManageImages={isAdminOrOwner(organization) || demoMode}
                        />
                    </FilterBarEnd>
                </>
            )}
        </FilterBar>
    );
}
