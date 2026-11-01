import { describe, expect, it } from 'vitest';
import { focusedPackageKeys, packageHref, packageRowKey, readPackageFocus } from './package-focus';

const rows = [
    { name: 'libxml2', version: '2.13.9-r0' },
    { name: 'libxml2', version: '2.12.7-r0' },
    { name: 'libxml2-utils', version: '2.13.9-r0' },
    { name: 'mystery', version: null },
];

describe('readPackageFocus', () => {
    it('reads the name and version a deep link carries', () => {
        expect(readPackageFocus(new URLSearchParams('name=libxml2&version=2.13.9-r0'))).toEqual({
            name: 'libxml2',
            version: '2.13.9-r0',
        });
    });

    it('leaves the version open when the link names only the package', () => {
        expect(readPackageFocus(new URLSearchParams('name=libxml2'))).toEqual({ name: 'libxml2', version: undefined });
    });

    it('is null without a name — a version alone means nothing, and so does an empty name', () => {
        expect(readPackageFocus(new URLSearchParams('version=1.0'))).toBeNull();
        expect(readPackageFocus(new URLSearchParams('name='))).toBeNull();
        expect(readPackageFocus(new URLSearchParams('search=libxml2'))).toBeNull();
    });
});

describe('focusedPackageKeys', () => {
    it('opens exactly the row of a name + version, not the prefix match beside it', () => {
        expect(focusedPackageKeys({ name: 'libxml2', version: '2.13.9-r0' }, rows)).toEqual([
            packageRowKey('libxml2', '2.13.9-r0'),
        ]);
    });

    it('opens every version of the name when the link gives none', () => {
        expect(focusedPackageKeys({ name: 'libxml2', version: undefined }, rows)).toEqual([
            packageRowKey('libxml2', '2.13.9-r0'),
            packageRowKey('libxml2', '2.12.7-r0'),
        ]);
    });

    it('matches a versionless row by an empty version, and nothing by a version it does not run as', () => {
        expect(focusedPackageKeys({ name: 'mystery', version: '' }, rows)).toEqual([packageRowKey('mystery', null)]);
        expect(focusedPackageKeys({ name: 'libxml2', version: '9.9.9' }, rows)).toEqual([]);
        expect(focusedPackageKeys(null, rows)).toEqual([]);
    });
});

describe('packageHref', () => {
    it('is the /packages link that opens the row, encoded, with the version only when known', () => {
        expect(packageHref('libxml2', '2.13.9-r0')).toBe('/packages?name=libxml2&version=2.13.9-r0');
        expect(packageHref('@babel/core', null)).toBe('/packages?name=%40babel%2Fcore');
        expect(packageHref('libxml2')).toBe('/packages?name=libxml2');
    });

    it('round-trips through readPackageFocus', () => {
        const params = new URLSearchParams(packageHref('@scope/pkg', '1.0.0+build').split('?')[1]);
        expect(readPackageFocus(params)).toEqual({ name: '@scope/pkg', version: '1.0.0+build' });
    });
});
