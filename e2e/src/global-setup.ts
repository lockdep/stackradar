import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { heartbeat, nginxDigest, reportInventory, uploadNginxSbom } from './api';
import { repoRoot, stack } from './stack';

/**
 * Runs once before every project: brings the Compose stack up (unless
 * E2E_BASE_URL names one that is already running) and seeds it the way a
 * scanner would — a heartbeat, an inventory with an nginx container and a
 * private-registry container the scanner could not pull (src/api.ts), and
 * the fixture SBOM for nginx's digest. Every step is idempotent, so a
 * stack that stays up between local runs is seeded once and then just
 * checked.
 *
 * Signing in is not done here: it is auth.setup.ts, a Playwright project
 * the others depend on, because it is itself a test of the first login.
 */
export default async function globalSetup(): Promise<void> {
    if (!stack.external) {
        const result = spawnSync(path.join(repoRoot, 'e2e', 'scripts', 'stack.sh'), ['up'], {
            cwd: repoRoot,
            stdio: 'inherit',
            env: process.env,
        });
        if (result.status !== 0) {
            throw new Error(`e2e/scripts/stack.sh up exited with ${result.status}; see the output above`);
        }
    }

    await waitForReady(`${stack.apiUrl}/api/health/ready`, 'server');
    await waitForReady(`${stack.baseUrl}/api/health/ready`, 'client');

    const digest = await nginxDigest();
    await heartbeat();
    await reportInventory({ nginxDigest: digest });
    const upload = await uploadNginxSbom(digest);
    console.log(
        upload.created
            ? `Seeded: uploaded the nginx SBOM (${upload.componentCount} components) as image ${upload.imageId}`
            : 'Seeded: the stack already had the nginx SBOM; the earlier upload stands',
    );
}

async function waitForReady(url: string, what: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
            last = `${res.status} ${await res.text()}`;
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${what} never reported ready at ${url} (last: ${last.slice(0, 300)})`);
}
