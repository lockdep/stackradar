'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { OrganizationSettingsView } from '@/views'
import { Suspense } from 'react'

function OrgSettingsContent() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    /* The active tab lives in the URL, not in component state. Upgrade
       prompts elsewhere push `?tab=billing` while this page is already
       mounted, and a `useState` seed would ignore that update. */
    const tab = searchParams.get('tab') ?? undefined

    const setTab = (id: string) => {
        const params = new URLSearchParams(searchParams.toString())
        if (id === 'general') params.delete('tab')
        else params.set('tab', id)
        const query = params.toString()
        router.replace(query ? `${pathname}?${query}` : pathname)
    }

    return <OrganizationSettingsView tab={tab} onTabChange={setTab} />
}

export default function OrgSettingsPage() {
    return (
        <Suspense>
            <OrgSettingsContent />
        </Suspense>
    )
}
