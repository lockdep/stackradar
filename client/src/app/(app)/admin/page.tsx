'use client';

import { useState } from 'react';
import { RefreshCw, Shield } from 'lucide-react';
import { TabBar, TabPanel, type TabBarItem } from '@/components/ui';
import { OverviewTab } from '@/views/admin/OverviewTab';
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

const TABS: AdminTab[] = [
    { id: 'overview', name: 'Overview' },
    // The tenant list, and the drill-down into one tenant. A single-org
    // install has nothing to list: its one org is the install.
    { id: 'organizations', name: 'Organizations', requires: 'multiOrg' },
    // The accounts and how each signs in, with local-password management —
    // only when local login is on; the cloud's accounts are all OAuth.
    { id: 'users', name: 'Users', requires: 'localLogin' },
    // Beside Organizations: both are about the people using the product,
    // before the tabs about what the product ingested. The cloud's inbox.
    { id: 'feedback', name: 'Feedback', requires: 'support' },
    // Before Vulnerabilities: `images` is the table the deployment side and the
    // advisory side meet on, and the state breakdown here explains gaps the
    // vulnerability figures otherwise get blamed for.
    { id: 'images', name: 'Images' },
    { id: 'vulnerabilities', name: 'Vulnerabilities' },
    // Between Vulnerabilities and Explorer on purpose: the mirror, then what the
    // matcher did with it, then a single component's version of the same story.
    { id: 'matcher', name: 'Matcher' },
    { id: 'explorer', name: 'Explorer' },
    { id: 'osv', name: 'OSV Sync' },
    // Beside OSV Sync: the advisory mirror, then the feeds that decorate it
    // (EPSS, KEV) and the chart mirror that runs on the same nightly cadence.
    { id: 'feeds', name: 'Feeds' },
    { id: 'jobs', name: 'Jobs' },
    // Last, and apart: the public chart index (charts.stackradar.io) is its
    // own app with its own database, run by the maintainers. Everything above
    // is the product's; in the community edition its route can only answer 503.
    { id: 'chart-index', name: 'Chart Index', requires: 'isCloud' },
];

export default function AdminPage() {
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

    const [activeTab, setActiveTab] = useState<Tab>('overview');
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
