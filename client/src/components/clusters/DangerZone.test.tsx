import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider'
import { resolveEdition } from '@/lib/edition'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('./ClusterContext', () => ({
    useCluster: () => ({ cluster: { id: 'c1', name: 'platform-eu1' }, setCluster: () => {} }),
}))

const { DangerZone } = await import('./DangerZone')

const render = (demoMode: boolean) =>
    renderToStaticMarkup(
        <RuntimeConfigProvider config={{ scannerChartVersion: null, demoMode, edition: resolveEdition('cloud'), localLogin: false }}>
            <DangerZone />
        </RuntimeConfigProvider>,
    )

describe('DangerZone', () => {
    it('offers cluster deletion when demo mode is off', () => {
        expect(render(false)).toContain('Delete cluster')
    })

    it('renders nothing in demo mode', () => {
        expect(render(true)).toBe('')
    })
})
