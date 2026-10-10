import { describe, expect, it } from 'vitest'
import { clearedSplit, groupFixes, splitRemainder } from './fix-groups'
import type { FixListItem, NoRecommendationItem } from '@/types/fixes'

const fix = (
    id: string,
    control: FixListItem['control'],
    scope: FixListItem['scope'],
    byScope?: { application: number; base: number }
): FixListItem => ({
    id,
    kind: 'image',
    measured: true,
    subject: id,
    release: null,
    from: '1.0',
    to: '1.1',
    bump: 'minor',
    cluster: { id: 'c', name: 'prod' },
    control,
    scope,
    cleared: { findings: 0, kev: 0, high: 0, introduced: 0, ...(byScope ? { byScope } : {}) },
    riskRemoved: 1,
    upperBound: null,
    workloads: 1,
    containers: 1,
    images: 1,
    delivery: null,
    target: { type: 'image', imageId: id },
})

describe('groupFixes', () => {
    it('orders: in your control (application, then base), then upstream — server rank kept inside each', () => {
        const sections = groupFixes([
            fix('u1', 'third-party', 'base'),
            fix('b1', 'built', 'base'),
            fix('a1', 'built', 'application'),
            fix('u2', 'third-party', 'application'),
            fix('a2', 'built', 'application'),
        ])
        expect(sections.map(s => [s.key, s.fixes.map(f => f.id)])).toEqual([
            ['yours-application', ['a1', 'a2']],
            ['yours-base', ['b1']],
            ['upstream', ['u1', 'u2']],
        ])
    })

    it('does not split upstream upgrades by what they clear', () => {
        expect(groupFixes([fix('u1', 'third-party', 'base'), fix('u2', 'third-party', 'application')])).toHaveLength(1)
    })

    it('files a row from an older server under your control, application', () => {
        expect(groupFixes([fix('x', undefined, undefined)]).map(s => s.key)).toEqual(['yours-application'])
    })
})

describe('splitRemainder', () => {
    it('folds third-party images with nothing to upgrade to into "waiting on upstream"', () => {
        const item = (imageId: string, control: NoRecommendationItem['control']): NoRecommendationItem => ({
            imageId, control, subject: imageId, currentTag: null, cluster: { id: 'c', name: null },
            findings: 1, kev: 0, risk: 1, reason: 'no-candidates', eolLines: [],
        })
        const { yours, waitingOnUpstream } = splitRemainder([item('a', 'built'), item('b', 'third-party'), item('c', undefined)])
        expect(yours.map(i => i.imageId)).toEqual(['a', 'c'])
        expect(waitingOnUpstream.map(i => i.imageId)).toEqual(['b'])
    })
})

describe('clearedSplit', () => {
    it('says where what a move clears lives, in the reader\'s words', () => {
        expect(clearedSplit(fix('x', 'built', 'base', { application: 12, base: 29 }))).toBe('12 in application packages · 29 in the base image')
        expect(clearedSplit(fix('x', 'built', 'base', { application: 0, base: 29 }))).toBe('all in the base image')
        expect(clearedSplit(fix('x', 'built', 'application', { application: 3, base: 0 }))).toBe('all in application packages')
        expect(clearedSplit(fix('x', 'built', 'application'))).toBeNull()
    })
})
