import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TierLensControl, TierLensEmpty } from './TierLensControl'

const counts = { application: 12, base: 231, all: 243 }

describe('TierLensControl', () => {
    it('renders the three segments with their counts and checks the active one', () => {
        const html = renderToStaticMarkup(<TierLensControl lens="application" onChange={() => {}} counts={counts} />)
        expect(html).toContain('role="radiogroup"')
        expect(html).toMatch(/aria-checked="true"[^>]*title="Dependencies your build added/)
        expect(html).toContain('Base image')
        expect(html).toContain('>12<')
        expect(html).toContain('>231<')
        expect(html).toContain('>243<')
        expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    })

    it('says the exploited override out loud on the Application segment', () => {
        const html = renderToStaticMarkup(<TierLensControl lens="all" onChange={() => {}} />)
        expect(html).toContain('Exploited findings in the base image are always shown.')
    })

    it('never says tier, os or runtime', () => {
        const html = renderToStaticMarkup(<TierLensControl lens="base" onChange={() => {}} counts={counts} />)
        expect(html).not.toMatch(/\btier\b|\bos\b|\bruntime\b/i)
    })
})

describe('TierLensEmpty', () => {
    it('points an empty Application view at the base image, with its count', () => {
        const html = renderToStaticMarkup(
            <TierLensEmpty lens="application" counts={{ application: 0, base: 231, all: 231 }} onChange={() => {}} />
        )
        expect(html).toContain('Nothing in your application packages.')
        expect(html).toContain('231 findings are in the base image')
    })

    it('renders nothing when the other bucket is empty too', () => {
        const html = renderToStaticMarkup(
            <TierLensEmpty lens="application" counts={{ application: 0, base: 0, all: 0 }} onChange={() => {}} />
        )
        expect(html).toBe('')
    })
})
