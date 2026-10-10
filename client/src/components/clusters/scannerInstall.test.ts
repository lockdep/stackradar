import { describe, expect, it } from 'vitest'
import { helmUpgradeCommand, isScannerOutdated } from './scannerInstall'

describe('isScannerOutdated', () => {
    it('is true only for a strictly older scanner', () => {
        expect(isScannerOutdated('0.3.0', '0.4.0')).toBe(true)
        expect(isScannerOutdated('0.4.0', '0.4.0')).toBe(false)
        expect(isScannerOutdated('0.5.0', '0.4.0')).toBe(false)
    })

    it('compares numerically, not lexically', () => {
        expect(isScannerOutdated('0.9.0', '0.10.0')).toBe(true)
        expect(isScannerOutdated('0.10.0', '0.9.0')).toBe(false)
    })

    it('tolerates a leading v on either side', () => {
        expect(isScannerOutdated('v0.3.0', '0.4.0')).toBe(true)
        expect(isScannerOutdated('0.3.0', 'v0.4.0')).toBe(true)
    })

    it('refuses when either version is missing or unparseable', () => {
        expect(isScannerOutdated(null, '0.4.0')).toBe(false)
        expect(isScannerOutdated('0.3.0', null)).toBe(false)
        expect(isScannerOutdated('unknown', '0.4.0')).toBe(false)
        expect(isScannerOutdated('0.3.0', 'latest')).toBe(false)
    })
})

describe('helmUpgradeCommand', () => {
    it('pins the version and feeds the installed user values back', () => {
        expect(helmUpgradeCommand('0.4.0')).toBe(
            [
                'helm get values stackradar-scanner --namespace stackradar -o yaml | \\',
                '  helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \\',
                '  --version 0.4.0 \\',
                '  --namespace stackradar -f -',
            ].join('\n')
        )
    })

    it('never reuses the old chart defaults, which pin the old image', () => {
        expect(helmUpgradeCommand('0.4.0')).not.toContain('--reuse-values')
    })
})
