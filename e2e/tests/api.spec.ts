import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { inventoryReport, nginxDigest, scannerHeaders } from '../src/api';
import { fixtures, stack } from '../src/stack';

/**
 * The scanner's side of the contract, over the wire and without a browser:
 * what a wrong key, an old payload and a repeated upload get back. The
 * server's own suite covers the rules in depth; this checks the deployed
 * stack answers them at all.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test('a wrong scanner key is refused', async ({ request }) => {
    const res = await request.post(`${stack.apiUrl}/v1/heartbeat`, {
        headers: scannerHeaders({ 'Content-Type': 'application/json' }, 'not-the-scanner-key'),
        data: {},
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid API key' });
});

test('an inventory payload of an older version is refused with the versions accepted', async ({ request }) => {
    test.setTimeout(3 * 60_000);
    // The limiter (five reports, two a minute) runs before the version check,
    // so a run on the heels of the last one waits its 429 out first.
    let res = await request.post(`${stack.apiUrl}/v1/inventory`, {
        headers: scannerHeaders({ 'Content-Type': 'application/json' }),
        data: { ...inventoryReport({ nginxDigest: await nginxDigest() }), version: 2 },
    });
    for (let attempt = 0; res.status() === 429 && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, (Number(res.headers()['retry-after']) || 35) * 1000));
        res = await request.post(`${stack.apiUrl}/v1/inventory`, {
            headers: scannerHeaders({ 'Content-Type': 'application/json' }),
            data: { ...inventoryReport({ nginxDigest: await nginxDigest() }), version: 2 },
        });
    }
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/inventory payload version/);
});

test('the SBOM check knows the uploaded digest and not an unknown one', async ({ request }) => {
    const known = await request.get(`${stack.apiUrl}/v1/sboms/check`, {
        headers: scannerHeaders(),
        params: { imageDigest: await nginxDigest() },
    });
    expect(known.ok()).toBe(true);
    expect(await known.json()).toEqual({ exists: true });

    const unknown = await request.get(`${stack.apiUrl}/v1/sboms/check`, {
        headers: scannerHeaders(),
        params: { imageDigest: `sha256:${'0'.repeat(64)}` },
    });
    expect(unknown.ok()).toBe(true);
    expect(await unknown.json()).toEqual({ exists: false });
});

test('uploading the same digest again without replace answers 409', async ({ request }) => {
    const res = await request.post(`${stack.apiUrl}/v1/sboms/upload/cyclonedx`, {
        headers: scannerHeaders({ 'Content-Type': 'application/json' }),
        params: { imageDigest: await nginxDigest(), imageRef: 'docker.io/nginx:1.27-alpine' },
        data: await readFile(fixtures.nginxSbom, 'utf8'),
    });
    expect(res.status()).toBe(409);
});
