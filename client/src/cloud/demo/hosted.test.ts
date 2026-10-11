// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { afterEach, describe, expect, it } from 'vitest';
import { demoUserEmail } from './hosted';

const original = process.env.DEMO_USER_EMAIL;

afterEach(() => {
    if (original === undefined) delete process.env.DEMO_USER_EMAIL;
    else process.env.DEMO_USER_EMAIL = original;
});

describe('demoUserEmail', () => {
    it('defaults to demo@stackradar.io', () => {
        delete process.env.DEMO_USER_EMAIL;
        expect(demoUserEmail()).toBe('demo@stackradar.io');
        process.env.DEMO_USER_EMAIL = '  ';
        expect(demoUserEmail()).toBe('demo@stackradar.io');
    });

    it('honours the override', () => {
        process.env.DEMO_USER_EMAIL = ' visitor@example.com ';
        expect(demoUserEmail()).toBe('visitor@example.com');
    });
});
