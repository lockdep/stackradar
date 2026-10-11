import { describe, expect, it } from 'vitest';
import {
    API_URL_PLACEHOLDER,
    HOSTED_API_URL,
    helmInstallCommand,
    helmUpgradeCommand,
    isScannerOutdated,
    scannerApiUrl,
} from './scannerInstall';

describe('isScannerOutdated', () => {
    it('is true only for a strictly older scanner', () => {
        expect(isScannerOutdated('0.3.0', '0.4.0')).toBe(true);
        expect(isScannerOutdated('0.4.0', '0.4.0')).toBe(false);
        expect(isScannerOutdated('0.5.0', '0.4.0')).toBe(false);
    });

    it('compares numerically, not lexically', () => {
        expect(isScannerOutdated('0.9.0', '0.10.0')).toBe(true);
        expect(isScannerOutdated('0.10.0', '0.9.0')).toBe(false);
    });

    it('tolerates a leading v on either side', () => {
        expect(isScannerOutdated('v0.3.0', '0.4.0')).toBe(true);
        expect(isScannerOutdated('0.3.0', 'v0.4.0')).toBe(true);
    });

    it('refuses when either version is missing or unparseable', () => {
        expect(isScannerOutdated(null, '0.4.0')).toBe(false);
        expect(isScannerOutdated('0.3.0', null)).toBe(false);
        expect(isScannerOutdated('unknown', '0.4.0')).toBe(false);
        expect(isScannerOutdated('0.3.0', 'latest')).toBe(false);
    });
});

describe('helmUpgradeCommand', () => {
    it('pins the version and feeds the installed user values back', () => {
        expect(helmUpgradeCommand('0.4.0')).toBe(
            [
                'helm get values stackradar-scanner --namespace stackradar -o yaml | \\',
                '  helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \\',
                '  --version 0.4.0 \\',
                '  --namespace stackradar -f -',
            ].join('\n'),
        );
    });

    it('never reuses the old chart defaults, which pin the old image', () => {
        expect(helmUpgradeCommand('0.4.0')).not.toContain('--reuse-values');
    });
});

describe('scannerApiUrl', () => {
    it('uses PUBLIC_API_URL when set, in either edition, without a trailing slash', () => {
        expect(scannerApiUrl('https://api.example.com/', false)).toEqual({
            url: 'https://api.example.com',
            placeholder: false,
        });
        expect(scannerApiUrl('https://api.example.com', true)).toEqual({
            url: 'https://api.example.com',
            placeholder: false,
        });
    });

    it('falls back to the hosted origin only in the cloud', () => {
        expect(scannerApiUrl(null, true)).toEqual({ url: HOSTED_API_URL, placeholder: false });
        expect(scannerApiUrl('  ', true)).toEqual({ url: HOSTED_API_URL, placeholder: false });
    });

    it('shows a placeholder, never the hosted origin, in a community install', () => {
        const result = scannerApiUrl(null, false);
        expect(result).toEqual({ url: API_URL_PLACEHOLDER, placeholder: true });
        expect(helmInstallCommand({ chartVersion: '0.4.0', apiUrl: result.url })).toContain(
            `--set stackradar.apiUrl="${API_URL_PLACEHOLDER}"`,
        );
        expect(helmInstallCommand({ chartVersion: '0.4.0', apiUrl: result.url })).not.toContain(HOSTED_API_URL);
    });
});

describe('helmInstallCommand', () => {
    it('omits the API URL when it is the chart default and emits it otherwise', () => {
        expect(helmInstallCommand({ chartVersion: '0.4.0', apiUrl: HOSTED_API_URL })).not.toContain('apiUrl');
        expect(helmInstallCommand({ chartVersion: '0.4.0', apiUrl: 'https://api.example.com' })).toContain(
            '--set stackradar.apiUrl="https://api.example.com"',
        );
    });
});
