"use client";

import { createContext, useContext } from "react";
import { resolveEdition, type Capabilities } from "@/lib/edition";

export interface RuntimeConfig {
    /**
     * The scanner Helm chart version the app advertises in install
     * instructions (e.g. `0.4.2`). `null` when unset — the UI then falls back
     * to a `<version>` placeholder and points at the releases page.
     */
    scannerChartVersion: string | null;
    /**
     * The live demo (`docs/live-demo/` step 02): `DEMO_MODE=true` on the
     * demo Deployment only. Components read this to leave out the controls
     * the server would refuse with `read_only_demo`, and to show the banner.
     * `false` is production, and the value nothing else may depend on.
     */
    demoMode: boolean;
    /**
     * Which edition this deployment is and what it can do (`lib/edition.ts`,
     * the mirror of the server's `src/edition.ts`). Every product gate in
     * the UI — the Billing tab, the org switcher, "Add cluster", the email
     * alert channel — reads this, never a count of rows or an env var.
     */
    edition: Capabilities;
    /**
     * Whether username/password sign-in is on (`lib/local-login.ts`, step 04
     * of the open-source plan): the admin Users tab and the profile page's
     * "Change password" card exist only then. Not part of `edition`, whose
     * shape mirrors the server's: this is a client-only switch.
     */
    localLogin: boolean;
}

const RuntimeConfigContext = createContext<RuntimeConfig>({
    scannerChartVersion: null,
    demoMode: false,
    edition: resolveEdition(undefined),
    localLogin: false,
});

export function useRuntimeConfig(): RuntimeConfig {
    return useContext(RuntimeConfigContext);
}

/**
 * Per-environment values read from the process environment by the server
 * layout and handed to client components. Same pattern as the PostHog key:
 * dev and prod run one image, so nothing here is NEXT_PUBLIC_-inlined at
 * build time — deployed environments set these in the client-config
 * ConfigMap in stackradar-gitops.
 */
export function RuntimeConfigProvider({
    config,
    children,
}: {
    config: RuntimeConfig;
    children: React.ReactNode;
}) {
    return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}
