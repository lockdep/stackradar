import { describe, expect, it } from 'vitest';
import { vulnTitle } from './vuln-title';

describe('vulnTitle', () => {
    it('leaves a short summary alone', () => {
        expect(vulnTitle(' Auth bypass in knownhosts ')).toBe('Auth bypass in knownhosts');
    });

    it('cuts a long summary at a word boundary and adds "..."', () => {
        const long =
            'Security fix for CVE-2026-42508 applied in: amazon-cloudwatch-agent 1.300070.0-r1, amazon-cloudwatch-agent 1.300071.0-r1, amazon-cloudwatch-agent-fips 1.300066.1-r1, apko 1.2.13-r0';
        const title = vulnTitle(long);
        expect(title.length).toBeLessThanOrEqual(143);
        expect(title.endsWith('...')).toBe(true);
        expect(title).not.toMatch(/[\s,]\.\.\.$/);
        expect(long.startsWith(title.slice(0, -3))).toBe(true);
    });

    it('hard-cuts text with no spaces', () => {
        expect(vulnTitle('a'.repeat(300))).toBe(`${'a'.repeat(140)}...`);
    });
});
