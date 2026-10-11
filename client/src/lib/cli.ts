/**
 * The zero-signup CLI, offered wherever the app asks for the agent install.
 *
 * A signed-in user without a cluster is one of two people: someone who has
 * cluster-admin and two minutes, or someone who wants to see a result before
 * trusting an in-cluster agent to a vendor they met today. The wizard serves
 * the first; this command serves the second.
 *
 * One entry per OS, because paste-and-it-works only holds if the line fits
 * the reader's machine: Homebrew is near-universal on macOS and rare on
 * Linux, and Windows has no installer (the release ships a zip), so it gets
 * the run command plus a download link. Mirrors the marketing site's table
 * (landing-page `src/lib/site.ts`); keep the two in step.
 */
export const CLI_PAGE_URL = 'https://stackradar.io/open-source/cli';
export const CLI_RELEASES_URL = 'https://github.com/lockdep/stackradar-cli/releases/latest';

export type CliOs = 'macos' | 'linux' | 'windows';

export interface CliInstall {
    label: string;
    command: string;
    /** One line under the command: what it does on this OS. */
    note: string;
}

export const CLI_INSTALLS: Record<CliOs, CliInstall> = {
    macos: {
        label: 'macOS',
        command: 'brew install lockdep/tap/stackradar && stackradar scan',
        note: 'Installs with Homebrew and scans your current kube context.',
    },
    linux: {
        label: 'Linux',
        // The raw script URL, not the stackradar.io/install.sh shortcut the
        // marketing hero uses: that shortcut is a redirect served by the
        // landing page, which deploys separately from this app, and a command
        // that 404s because the other app is behind is worse than a long one.
        command:
            'curl -fsSL https://raw.githubusercontent.com/lockdep/stackradar-cli/main/install.sh | sh && stackradar scan',
        note: 'Downloads the signed release from GitHub into /usr/local/bin and scans your current kube context.',
    },
    windows: {
        label: 'Windows',
        command: '.\\stackradar.exe scan',
        note: 'Download the Windows zip from the releases page, unzip it, then run this in PowerShell.',
    },
};

export const CLI_OS_ORDER: CliOs[] = ['macos', 'linux', 'windows'];

/** Best-effort platform read for the default tab; macOS when unsure. Client-only. */
export function detectCliOs(): CliOs {
    if (typeof navigator === 'undefined') return 'macos';
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = (nav.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (platform.includes('win') || ua.includes('windows')) return 'windows';
    if (platform.includes('linux') || ua.includes('linux')) return 'linux';
    return 'macos';
}
