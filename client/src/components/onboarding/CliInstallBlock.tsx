'use client';

import { useState, useSyncExternalStore } from 'react';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CLI_INSTALLS, CLI_OS_ORDER, CLI_RELEASES_URL, detectCliOs, type CliOs } from '@/lib/cli';

/* The platform never changes during a session, so the "store" is a constant
   read: server snapshot macOS, client snapshot the detected OS — the
   hydration-safe way to read a browser-only value without a setState in an
   effect. */
const subscribe = () => () => {};
const getServerOs = (): CliOs => 'macos';

/**
 * The CLI command for the reader's OS: a three-word switch, the command in
 * the app's standard copyable block, and one line saying what it does.
 * Defaults to the detected platform (server render shows macOS, so a Linux
 * or Windows reader sees one repaint on hydration rather than a layout shift).
 * Shared by `TryCliCard` and the sign-in page.
 */
export function CliInstallBlock() {
    const detected = useSyncExternalStore(subscribe, detectCliOs, getServerOs);
    const [chosen, setChosen] = useState<CliOs | null>(null);
    const os = chosen ?? detected;

    const install = CLI_INSTALLS[os];

    return (
        <div>
            {/* Toggle buttons with `aria-pressed`, padded to a 28px target
                and pulled into the margin so the text still meets the edge. */}
            <div role="group" aria-label="Operating system" className="-mr-2 mb-1 flex justify-end gap-1">
                {CLI_OS_ORDER.map((key) => {
                    const active = key === os;
                    return (
                        <button
                            key={key}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setChosen(key)}
                            className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                                active
                                    ? 'text-ink underline decoration-accent-emphasis underline-offset-4'
                                    : 'text-ink-muted hover:text-ink'
                            }`}
                        >
                            {CLI_INSTALLS[key].label}
                        </button>
                    );
                })}
            </div>
            <CodeBlock code={install.command} />
            <p className="mt-2 text-xs text-ink-muted">
                {os === 'windows' ? (
                    <>
                        <a
                            href={CLI_RELEASES_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-accent hover:underline"
                        >
                            Download the Windows zip
                        </a>
                        , unzip it, then run this in PowerShell.
                    </>
                ) : (
                    install.note
                )}
            </p>
        </div>
    );
}
