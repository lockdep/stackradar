'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button, Spinner } from '@/components/ui'
import { useOrganization, useRuntimeConfig } from '@/components/providers'
import { OnboardingScreen } from '@/components/onboarding/OnboardingScreen'
import { Sidebar } from '@/components/Sidebar'
import { MirrorBanner } from '@/components/MirrorBanner'
import { SearchProvider } from '@/components/search'
/* The cloud's surfaces, each drawn behind an `edition` check: the terms
   gate, the live demo's banner and toast, the landing page's upgrade
   intent. `@/cloud` is the one import the licence boundary allows here. */
import { DemoBanner, DemoReadOnlyToast, TermsAcceptanceScreen, UpgradeIntent, useTermsGate } from '@/cloud'
import { useRouter } from 'next/navigation'

const hasClusterKey = (orgId: string) => `sr_org_has_cluster_${orgId}`
const onboardingSkipKey = (orgId: string) => `sr_onboarding_skipped_${orgId}`

type OnboardingGate = 'checking' | 'needed' | 'clear'

/**
 * Until an org has its first cluster, the app is the setup wizard and nothing
 * else. The answer is cached per org in localStorage so returning users render
 * the app without waiting on the check; the fetch still runs to correct the
 * cache (e.g. the org's only cluster was deleted elsewhere).
 *
 * Fails open: a failed check renders the app, never a locked door.
 *
 * `enabled` false (the community edition, `edition.multiCluster`) means
 * there is no wizard: the wizard creates a cluster, which the server
 * refuses there, and the one cluster was created at start-up anyway.
 */
function useOnboardingGate(orgId: string | null, enabled: boolean) {
    const [gate, setGate] = useState<OnboardingGate>(enabled ? 'checking' : 'clear')

    useEffect(() => {
        if (!orgId) return
        if (!enabled) {
            setGate('clear')
            return
        }

        const skipped = localStorage.getItem(onboardingSkipKey(orgId)) === 'true'
        const knownHasCluster = localStorage.getItem(hasClusterKey(orgId)) === 'true'
        setGate(skipped || knownHasCluster ? 'clear' : 'checking')

        let cancelled = false
        ;(async () => {
            try {
                const response = await fetch('/api/clusters')
                if (!response.ok) throw new Error('cluster check failed')
                const data = await response.json()
                const hasCluster = Array.isArray(data.clusters) && data.clusters.length > 0
                if (cancelled) return
                if (hasCluster) {
                    localStorage.setItem(hasClusterKey(orgId), 'true')
                    setGate('clear')
                } else {
                    localStorage.removeItem(hasClusterKey(orgId))
                    setGate(skipped ? 'clear' : 'needed')
                }
            } catch {
                if (!cancelled) setGate('clear')
            }
        })()
        return () => { cancelled = true }
    }, [orgId, enabled])

    const markClusterReady = useCallback(() => {
        if (orgId) localStorage.setItem(hasClusterKey(orgId), 'true')
        setGate('clear')
    }, [orgId])

    const skip = useCallback(() => {
        if (orgId) localStorage.setItem(onboardingSkipKey(orgId), 'true')
        setGate('clear')
    }, [orgId])

    return { gate, markClusterReady, skip }
}

function OrganizationSetupScreen({ isLoading, error, onRetry }: { isLoading: boolean; error: string | null; onRetry: () => void }) {
    return (
        <div className="min-h-screen bg-surface flex items-center justify-center">
            <div className="text-center max-w-md px-6">
                <h1 className="text-2xl font-bold text-ink mb-2">StackRadar</h1>

                {isLoading && !error && (
                    <>
                        <p className="text-ink-muted mb-6">Loading your workspace...</p>
                        <div className="flex justify-center">
                            <Spinner size="lg" className="text-ink-faint" />
                        </div>
                    </>
                )}

                {error && (
                    <>
                        <div className="bg-danger-subtle border border-danger-muted rounded-md p-4 mb-6">
                            <div className="flex items-start gap-3">
                                <TriangleAlert className="size-5 text-danger shrink-0 mt-0.5" />
                                <div className="text-left">
                                    <p className="text-danger font-medium">Setup failed</p>
                                    <p className="text-danger text-sm mt-1">{error}</p>
                                </div>
                            </div>
                        </div>
                        <Button variant="primary" size="lg" onClick={onRetry}>
                            <RefreshCw className="size-4" />
                            Try again
                        </Button>
                    </>
                )}
            </div>
        </div>
    )
}

export function AppShell({ children }: { children: React.ReactNode }) {
    const { data: session, status: sessionStatus } = useSession()
    const { organization, isLoading: orgLoading, error: orgError, retry: retryOrg } = useOrganization()
    const { demoMode, edition } = useRuntimeConfig()
    // Keyed on the org being resolved, not just the session: for a brand-new
    // user that means /api/users/setup (which records their acceptance) has
    // already completed, so the check can't race it and flash the gate.
    // Skipped in the demo and in the community edition, which has no terms.
    const { gate: termsGate, accept: acceptTerms, isAccepting: termsAccepting, error: termsError } = useTermsGate(
        organization ? session?.user?.id ?? null : null,
        demoMode || !edition.isCloud,
    )
    const { gate, markClusterReady, skip } = useOnboardingGate(organization?.id ?? null, edition.multiCluster)
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const router = useRouter()

    const userName = session?.user?.name || 'User'
    const userImage = session?.user?.image || null
    const userEmail = session?.user?.email || ''
    const isAdmin = session?.user?.isAdmin === true

    if (sessionStatus === 'authenticated' && (orgLoading || orgError || !organization)) {
        return <OrganizationSetupScreen isLoading={orgLoading} error={orgError} onRetry={retryOrg} />
    }

    if (sessionStatus === 'authenticated' && organization) {
        if (termsGate === 'checking' || gate === 'checking') {
            return <OrganizationSetupScreen isLoading error={null} onRetry={retryOrg} />
        }
        // Terms come before the setup wizard: nothing else in the app until
        // the current version is accepted.
        if (termsGate === 'needed') {
            return <TermsAcceptanceScreen onAccept={acceptTerms} isAccepting={termsAccepting} error={termsError} />
        }
        if (gate === 'needed') {
            return (
                <OnboardingScreen
                    /* The screen creates the org's first cluster on mount, so
                       an org switch must be a fresh mount, never a reuse. */
                    key={organization.id}
                    orgName={organization.name}
                    onClusterReady={markClusterReady}
                    onSkip={skip}
                />
            )
        }
    }

    return (
        /* The global search palette lives here, inside the org and runtime
           config providers and outside every page, so ⌘K, `/` and the
           sidebar trigger mean one thing on every authenticated screen. */
        <SearchProvider>
        <div>
            <Sidebar
                sidebarOpen={sidebarOpen}
                setSidebarOpen={setSidebarOpen}
                onOrganizationChange={() => router.push('/clusters')}
                userName={userName}
                userImage={userImage}
                userEmail={userEmail}
                isAdmin={isAdmin}
            />
            {/* The demo's disclosure sits in the content column, under the
                mobile top bar and beside the desktop sidebar, so every page
                carries it without the sidebar having to know. */}
            {demoMode && (
                <div className="lg:pl-72">
                    <DemoBanner />
                </div>
            )}
            {/* A fresh install's OSV bootstrap, said out loud on every page
                until it has finished; renders nothing once the mirror is live. */}
            <div className="lg:pl-72">
                <MirrorBanner />
            </div>
            <main className="py-5 sm:py-8 lg:pl-72">
                <div className="px-4 sm:px-6 lg:px-8">
                    {edition.billing && <UpgradeIntent />}
                    {children}
                </div>
            </main>
            {demoMode && <DemoReadOnlyToast />}
        </div>
        </SearchProvider>
    )
}
