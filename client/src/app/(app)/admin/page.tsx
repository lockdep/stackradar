'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RefreshCw, Shield } from 'lucide-react';
import { TabBar, TabPanel, type TabBarItem } from '@/components/ui';
import { OverviewTab } from '@/views/admin/OverviewTab';
import { SystemTab } from '@/views/admin/SystemTab';
import { OrganizationsTab } from '@/views/admin/OrganizationsTab';
import { AdminOrgDetail } from '@/views/admin/AdminOrgDetail';
import { ImagesTab } from '@/views/admin/ImagesTab';
import { VulnerabilitiesTab } from '@/views/admin/VulnerabilitiesTab';
import { MatcherTab } from '@/views/admin/MatcherTab';
import { ExplorerTab } from '@/views/admin/ExplorerTab';
import { OsvTab } from '@/views/admin/OsvTab';
import { FeedsTab } from '@/views/admin/FeedsTab';
import { JobsTab } from '@/views/admin/JobsTab';
import { UsersTab } from '@/views/admin/UsersTab';
import { useRuntimeConfig } from '@/components/providers';
import { ChartIndexTab, FeedbackTab } from '@/cloud';
import type { RecentOrg, Tab } from '@/views/admin/types';

/**
 * What a tab needs before it is drawn. The capabilities are the edition's
 * (`lib/edition.ts`) plus `localLogin`, which is a client-only switch; a
 * tab names the one it depends on and the page filters, so the page never
 * knows why any tab is missing.
 */
type AdminCapability = 'multiOrg' | 'support' | 'isCloud' | 'localLogin';

interface AdminTab extends TabBarItem {
    id: Tab;
    requires?: AdminCapability;
}

/**
 * Grouped, in the order a person reads the page: is it working (Health),
 * what it holds (Data), what it knows (Advisories), who uses it (People),
 * and the maintainers' own index last and apart. The strip draws a group
 * label before the first tab of each on wide screens; a tab's group must
 * be adjacent to its siblings, so the order here is the grouping.
 */
const TABS: AdminTab[] = [
    { id: 'overview', name: 'Overview', group: 'Health' },
    // What this install is: versions, edition, topology, every knob's
    // effective value, sign-in methods, both schemas' state. Read-only.
    { id: 'system', name: 'System', group: 'Health' },
    { id: 'jobs', name: 'Jobs', group: 'Health' },
    // `images` is the table the deployment side and the advisory side meet
    // on, and the state breakdown there explains gaps the vulnerability
    // figures otherwise get blamed for; the Explorer drills from one row.
    { id: 'images', name: 'Images', group: 'Data' },
    { id: 'explorer', name: 'Explorer', group: 'Data' },
    // The mirror, what the matcher did with it, then the sync that fills it
    // and the feeds that decorate it (EPSS, KEV, the chart mirror).
    { id: 'vulnerabilities', name: 'Vulnerabilities', group: 'Advisories' },
    { id: 'matcher', name: 'Matcher', group: 'Advisories' },
    { id: 'osv', name: 'OSV Sync', group: 'Advisories' },
    { id: 'feeds', name: 'Feeds', group: 'Advisories' },
    // The accounts and how each signs in, with local-password management —
    // only when local login is on; the cloud's accounts are all OAuth.
    { id: 'users', name: 'Users', group: 'People', requires: 'localLogin' },
    // The tenant list, and the drill-down into one tenant. A single-org
    // install has nothing to list: its one org is the install.
    { id: 'organizations', name: 'Organizations', group: 'People', requires: 'multiOrg' },
    // The cloud's inbox.
    { id: 'feedback', name: 'Feedback', group: 'People', requires: 'support' },
    // Last, and apart: the public chart index (charts.stackradar.io) is its
    // own app with its own database, run by the maintainers. Everything above
    // is the product's; in the community edition its route can only answer 503.
    { id: 'chart-index', name: 'Chart Index', group: 'Index', requires: 'isCloud' },
];

/** `useSearchParams` wants a Suspense boundary above it; the page is that boundary. */
export default function AdminPage() {
    return (
        <Suspense>
            <AdminPageContent />
        </Suspense>
    );
}

function AdminPageContent() {
    const { edition, localLogin } = useRuntimeConfig();
    const caps: Record<AdminCapability, boolean> = {
        multiOrg: edition.multiOrg,
        support: edition.support,
        isCloud: edition.isCloud,
        localLogin,
    };
    const tabs = TABS.filter((t) => !t.requires || caps[t.requires]);
    const has = (id: Tab) => tabs.some((t) => t.id === id);

    // The cloud operator's page is the platform's; a self-hosting admin's is
    // the one install's. Same tabs, different sentence.
    const title = edition.multiOrg ? 'Admin Dashboard' : 'Administration';
    const subtitle = edition.multiOrg
        ? 'Platform-wide health and statistics'
        : "This install's health, data and accounts";

    // `?tab=` is how a tile elsewhere opens a specific tab (the Overview's
    // out-of-retries tile links to the Jobs tab); a tab the edition hides
    // falls back to the Overview rather than an empty page.
    const requested = useSearchParams().get('tab');
    const [activeTab, setActiveTab] = useState<Tab>(() =>
        requested && tabs.some((t) => t.id === requested) ? (requested as Tab) : 'overview',
    );
    const [refreshKey, setRefreshKey] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [selectedOrg, setSelectedOrg] = useState<RecentOrg | null>(null);

    // Only reachable from the Organizations tab, so it goes with it.
    if (selectedOrg && has('organizations')) {
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-ink-muted mb-4">
                    <Shield className="size-4 text-ink-faint" />
                    <button
                        type="button"
                        onClick={() => setSelectedOrg(null)}
                        className="hover:text-ink cursor-pointer"
                    >
                        {title}
                    </button>
                </div>
                <AdminOrgDetail org={selectedOrg} onBack={() => setSelectedOrg(null)} />
            </div>
        );
    }

    return (
        <div className="min-w-0 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-ink flex items-center gap-2">
                        <Shield className="size-5 text-ink-faint" />
                        {title}
                    </h1>
                    <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>
                </div>
                <button
                    onClick={() => setRefreshKey((k) => k + 1)}
                    disabled={isRefreshing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-ink-secondary hover:text-ink hover:bg-surface-hover rounded-md transition-colors cursor-pointer disabled:opacity-50"
                >
                    <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Twelve tabs never fit a phone; the strip's own `overflow-x-auto`
                scrolls them, and `min-w-0` on the page keeps that scroll inside
                the strip rather than widening the page body. */}
            <TabBar
                tabs={tabs}
                activeTab={activeTab}
                onChange={(id) => setActiveTab(id as Tab)}
                label="Admin sections"
            />

            <TabPanel tabId="overview" active={activeTab === 'overview'}>
                <OverviewTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="system" active={activeTab === 'system'}>
                <SystemTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            {has('organizations') && (
                <TabPanel tabId="organizations" active={activeTab === 'organizations'}>
                    <OrganizationsTab
                        refreshKey={refreshKey}
                        onLoadingChange={setIsRefreshing}
                        onSelectOrg={setSelectedOrg}
                    />
                </TabPanel>
            )}
            {has('users') && (
                <TabPanel tabId="users" active={activeTab === 'users'}>
                    <UsersTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
                </TabPanel>
            )}
            {has('feedback') && (
                <TabPanel tabId="feedback" active={activeTab === 'feedback'}>
                    <FeedbackTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
                </TabPanel>
            )}
            <TabPanel tabId="images" active={activeTab === 'images'}>
                <ImagesTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="vulnerabilities" active={activeTab === 'vulnerabilities'}>
                <VulnerabilitiesTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="matcher" active={activeTab === 'matcher'}>
                <MatcherTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="explorer" active={activeTab === 'explorer'}>
                <ExplorerTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="osv" active={activeTab === 'osv'}>
                <OsvTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="feeds" active={activeTab === 'feeds'}>
                <FeedsTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            <TabPanel tabId="jobs" active={activeTab === 'jobs'}>
                <JobsTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
            </TabPanel>
            {has('chart-index') && (
                <TabPanel tabId="chart-index" active={activeTab === 'chart-index'}>
                    <ChartIndexTab refreshKey={refreshKey} onLoadingChange={setIsRefreshing} />
                </TabPanel>
            )}
        </div>
    );
}
