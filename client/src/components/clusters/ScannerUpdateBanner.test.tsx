import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider'
import { resolveEdition } from '@/lib/edition'
import type { Cluster } from '@/types/cluster'
import { ScannerUpdateBanner } from './ScannerUpdateBanner'

const cluster = (name: string, scannerVersion: string | null) =>
    ({ id: name, name, scannerVersion }) as Cluster

const render = (
    clusters: Cluster[],
    config: { scannerChartVersion: string | null; demoMode?: boolean },
) =>
    renderToStaticMarkup(
        <RuntimeConfigProvider config={{ demoMode: false, edition: resolveEdition('cloud'), localLogin: false, ...config }}>
            <ScannerUpdateBanner clusters={clusters} />
        </RuntimeConfigProvider>,
    )

describe('ScannerUpdateBanner', () => {
    it('names the cluster and both versions when one scanner is behind', () => {
        const html = render([cluster('stackradar-development', '0.3.0')], { scannerChartVersion: '0.4.0' })
        expect(html).toContain('0.4.0')
        expect(html).toContain('stackradar-development is running')
        expect(html).toContain('How to update')
    })

    it('counts the clusters when several are behind', () => {
        const html = render(
            [cluster('a', '0.3.0'), cluster('b', '0.2.0'), cluster('c', '0.4.0')],
            { scannerChartVersion: '0.4.0' },
        )
        expect(html).toContain('2 clusters are running an older version')
    })

    it('renders nothing when every scanner is current, unreported or ahead', () => {
        const clusters = [cluster('a', '0.4.0'), cluster('b', null), cluster('c', '0.5.0')]
        expect(render(clusters, { scannerChartVersion: '0.4.0' })).toBe('')
    })

    it('renders nothing without an advertised version, or in demo mode', () => {
        const clusters = [cluster('a', '0.3.0')]
        expect(render(clusters, { scannerChartVersion: null })).toBe('')
        expect(render(clusters, { scannerChartVersion: '0.4.0', demoMode: true })).toBe('')
    })
})
