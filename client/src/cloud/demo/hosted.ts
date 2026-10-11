// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * The hosted demo's two constants — where it lives and whom it signs in as.
 * In the cloud tree because both name the maintainers' deployment: an AGPL
 * install that imported `lib/demo.ts` carried `demo.stackradar.io` and
 * `demo@stackradar.io` in its bundle for a demo it does not run. The core
 * keeps `isDemoMode()` and the session length, which any deployment that
 * sets `DEMO_MODE` needs.
 */

/**
 * Where the demo lives, for the pages of the real app that offer it (the
 * login page). `/demo/enter` rather than the bare host: the host only
 * redirects there, and the direct link lands the visitor signed in.
 */
export const DEMO_URL = 'https://demo.stackradar.io/demo/enter';

/** The user `/demo/enter` signs visitors in as. The server's demo seed creates it. */
export function demoUserEmail(): string {
    return process.env.DEMO_USER_EMAIL?.trim() || 'demo@stackradar.io';
}
