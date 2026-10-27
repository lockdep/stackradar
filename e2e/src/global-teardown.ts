import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot, stack } from './stack';

/**
 * Tears the stack down, database volume included, only when asked
 * (E2E_TEARDOWN=1, which the CI workflow sets) and never for a stack this
 * run did not start. Locally the stack stays up so the next run starts in
 * seconds: `pnpm stack:down` is the way to get a fresh database.
 */
export default async function globalTeardown(): Promise<void> {
    if (stack.external || process.env.E2E_TEARDOWN !== '1') return;
    spawnSync(path.join(repoRoot, 'e2e', 'scripts', 'stack.sh'), ['down'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
    });
}
