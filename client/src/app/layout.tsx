import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import {
    SessionProvider,
    OrganizationProvider,
    ThemeProvider,
    PostHogProvider,
    RuntimeConfigProvider,
} from '@/components/providers';
import { auth } from '@/auth';
import { isDemoMode } from '@/lib/demo';
import { readEdition } from '@/lib/edition';
import { isLocalLoginEnabled } from '@/lib/local-login';
import './globals.css';

const inter = Inter({
    variable: '--font-inter',
    subsets: ['latin'],
});

const jetbrainsMono = JetBrains_Mono({
    variable: '--font-jetbrains-mono',
    subsets: ['latin'],
});

/**
 * The origin absolute metadata URLs resolve against: the deployment's
 * `AUTH_URL` when it pins one (its origin only — Auth.js accepts a path
 * there), otherwise the hosted product's. A self-hosted install that sets
 * `AUTH_TRUST_HOST` alone gets the fallback, which only affects Open Graph
 * previews of a page nobody can open without signing in.
 */
function metadataOrigin(): URL {
    const configured = process.env.AUTH_URL?.trim();
    if (configured) {
        try {
            return new URL(new URL(configured).origin);
        } catch {
            // fall through to the default
        }
    }
    return new URL('https://app.stackradar.io');
}

export const metadata: Metadata = {
    metadataBase: metadataOrigin(),
    title: 'StackRadar - SBOM Tracker',
    description: 'Track your software dependencies, vulnerabilities, and compliance in one place',
    // The dashboard is behind login; nothing here should be in a search
    // index. The marketing site (stackradar.io) is the indexable surface, and
    // /login with its `callbackUrl` variants was showing up as duplicate
    // thin pages in site audits.
    robots: { index: false, follow: false },
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const session = await auth();
    const demoMode = isDemoMode();

    // Applies the persisted theme before first paint so there is no flash of
    // the wrong theme. Must stay in sync with THEME_STORAGE_KEY.
    const themeInitScript = `(function(){try{var t=localStorage.getItem("sr-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})()`;

    return (
        <html lang="en" className="h-full bg-surface" suppressHydrationWarning>
            <body className={`${inter.variable} ${jetbrainsMono.variable} antialiased h-full`}>
                <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
                <PostHogProvider
                    apiKey={process.env.POSTHOG_KEY}
                    userId={session?.user?.id}
                    userEmail={session?.user?.email}
                    demoMode={demoMode}
                >
                    <RuntimeConfigProvider
                        config={{
                            scannerChartVersion: process.env.SCANNER_CHART_VERSION?.trim() || null,
                            publicApiUrl: process.env.PUBLIC_API_URL?.trim() || null,
                            demoMode,
                            edition: readEdition(),
                            localLogin: isLocalLoginEnabled(),
                        }}
                    >
                        <ThemeProvider>
                            <SessionProvider session={session}>
                                <OrganizationProvider>{children}</OrganizationProvider>
                            </SessionProvider>
                        </ThemeProvider>
                    </RuntimeConfigProvider>
                </PostHogProvider>
            </body>
        </html>
    );
}
