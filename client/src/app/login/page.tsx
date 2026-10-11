import type { Metadata } from 'next';
import { signIn, auth } from '@/auth';
import { redirect } from 'next/navigation';
import { isProviderEnabled, oidcDisplayName } from '@/lib/auth-providers';
import { isDemoMode } from '@/lib/demo';
import { readEdition } from '@/lib/edition';
import { isLocalLoginEnabled } from '@/lib/local-login';
import { cookies } from 'next/headers';
import { Check, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LocalLoginForm } from './LocalLoginForm';
import {
    ATTRIBUTION_COOKIE,
    ATTRIBUTION_COOKIE_MAX_AGE,
    DEMO_URL,
    attributionFromSearchParams,
    serializeAttributionCookie,
    type Attribution,
} from '@/cloud';

// One canonical for every `?callbackUrl=` variant of this page.
export const metadata: Metadata = {
    title: 'Sign in - StackRadar',
    alternates: { canonical: '/login' },
};

/**
 * The three objections a platform engineer raises about an in-cluster agent,
 * in the order they come up (effort, time-to-value, data) — the same twelve
 * words as the marketing site's CTA block, so the two ends of the funnel make
 * the same promise. "First findings within minutes" is the site-wide
 * time-to-value phrase; tighten it to a number only once it has been timed.
 */
const ASSURANCES = ['One Helm command', 'First findings within minutes', 'Only package lists leave the cluster'];

/**
 * The figure on the proof panel; see the panel's comment for where it comes
 * from and how to refresh it. 16,539 on `measuredOn`.
 */
const CHART_INDEX_COUNT = { value: '16,500+', measuredOn: '2026-09-10' };

/** The one look both provider buttons share; see the comment above them. */
const PROVIDER_BUTTON =
    'h-11 text-[15px] bg-surface-raised shadow-resting hover:bg-surface-raised hover:border-edge-strong';

function GitHubIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
    );
}

function GoogleIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24">
            <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
        </svg>
    );
}

/**
 * Keeps the ad-click parameters the marketing site put on the login link
 * (`lib/attribution.ts`) alive across the OAuth round trip, which drops the
 * query. Written by the sign-in action just before the provider redirect,
 * read and cleared by the first dashboard load's `POST /api/users/setup`.
 * Nothing to do for a visitor who arrived without them.
 */
async function rememberAttribution(attribution: Attribution | null): Promise<void> {
    if (!attribution) return;
    (await cookies()).set(ATTRIBUTION_COOKIE, serializeAttributionCookie(attribution), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: ATTRIBUTION_COOKIE_MAX_AGE,
    });
}

export default async function LoginPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await auth();
    const params = await searchParams;
    const callbackUrl = Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl;
    // The terms line, the live-demo door and ad attribution are the cloud's;
    // a self-hosted install has neither a contract with us, a demo to point
    // at, nor a campaign to credit a sign-up to.
    const { isCloud } = readEdition();
    const attribution = isCloud ? attributionFromSearchParams(params) : null;

    // Only honor same-origin relative paths ("/..." but not "//...") so the
    // callbackUrl can't be abused as an open redirect.
    const redirectTo = callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/';

    // Checks `session.user`, not bare `session`, to match `proxy.ts` and the BFF
    // routes: an existence check on the session object alone is the pattern that
    // failed open on auth misconfiguration in GHSA-8fpg-xm3f-6cx3.
    if (session?.user) {
        redirect(redirectTo);
    }

    // Buttons mirror the providers registered in `auth.ts`: both read
    // `isProviderEnabled`, so a provider without credentials never shows a
    // button that would 404 on submit.
    const showGitHub = isProviderEnabled('github');
    const showGoogle = isProviderEnabled('google');
    // Generic OIDC and local username/password: the self-hosted install's
    // sign-ins. Local goes first when it is
    // on — it is the one that works on a bare install — with the provider
    // buttons under a divider; an install that turned it off sees providers
    // only, which is how an OIDC-only shop hides the form once its IdP works.
    const showOidc = isProviderEnabled('oidc');
    const showLocal = isLocalLoginEnabled();
    const providerCount = Number(showGitHub) + Number(showGoogle) + Number(showOidc);
    return (
        <div className="min-h-screen bg-surface lg:grid lg:grid-cols-2">
            {/* Split screen from `lg` (Semrush's sign-up page is the model, 2026-09-15):
          the form on the left, one proof card on a soft colour panel on the
          right. Below `lg` the panel is not drawn and the left column is the
          whole page. */}

            {/* Left: brand top-left, form centred in the column and left-aligned
          within itself. No card around the form any more — the panel on
          the right is the page's one framed object, and a second frame
          around the buttons made two boxes compete. */}
            <div className="flex min-h-screen flex-col lg:min-h-0">
                {/* Branding: the dot + wordmark from the marketing site's header
            (landing-page Header.tsx), reproduced exactly so the visitor who
            just clicked "Get started" there sees the same mark here. A link
            back to the site: this page has no other way out. */}
                <div className="px-6 py-6 lg:px-10">
                    <a
                        href="https://stackradar.io"
                        className="-m-1.5 inline-flex items-center gap-2 rounded-md p-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                        <span className="inline-flex size-2 rounded-full bg-accent" aria-hidden="true" />
                        <span className="text-xl font-semibold text-ink tracking-tight">StackRadar</span>
                    </a>
                </div>

                <div className="flex flex-1 items-center px-6 pb-16 lg:px-10">
                    <div className="mx-auto w-full max-w-sm">
                        {/* The heading is the outcome, not the task: the marketing
                hero's own claim, so the reader who clicked "Show me my
                cluster" lands on the same sentence. "Sign in" is implied
                by the buttons. The subline is the offer in six words. */}
                        <h1 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">
                            Know which pods run a new CVE.
                        </h1>
                        <p className="mt-3 text-base text-ink-muted">Connect one cluster free. No credit card.</p>

                        {/* Two equal buttons, neither filled. The provider choice is an
                identity question, not a persuasion one: the visitor has
                already decided to sign in, and a filled GitHub button (tried
                2026-09-15) only told Google users they were second-class,
                while putting the GitHub mark on StackRadar blue. What makes
                the pair read as pressable is contrast against the page, not
                colour: white (`surface-raised`) on the grey canvas, with
                `shadow-resting` and a border that firms up on hover —
                GitHub's own sign-in pattern. White also keeps Google's
                coloured "G" on the background its guidelines expect. 44px
                tall (`h-11`), the marketing site's CTA height and a
                thumb-sized target; `h-11` wins over the size preset's
                `h-10` by Tailwind's ascending-value emission order (see
                Button.tsx). */}
                        <div className="mt-8 space-y-3">
                            {showLocal && <LocalLoginForm callbackUrl={redirectTo} />}

                            {showLocal && providerCount > 0 && (
                                <div className="flex items-center gap-3 py-1 text-xs text-ink-muted" aria-hidden="true">
                                    <span className="h-px flex-1 bg-edge" />
                                    or
                                    <span className="h-px flex-1 bg-edge" />
                                </div>
                            )}

                            {showGitHub && (
                                <form
                                    action={async () => {
                                        'use server';
                                        await rememberAttribution(attribution);
                                        await signIn('github', { redirectTo });
                                    }}
                                >
                                    <Button
                                        type="submit"
                                        variant="secondary"
                                        size="lg"
                                        fullWidth
                                        className={PROVIDER_BUTTON}
                                    >
                                        <GitHubIcon className="size-5" />
                                        Continue with GitHub
                                    </Button>
                                </form>
                            )}

                            {showGoogle && (
                                <form
                                    action={async () => {
                                        'use server';
                                        await rememberAttribution(attribution);
                                        await signIn('google', { redirectTo });
                                    }}
                                >
                                    <Button
                                        type="submit"
                                        variant="secondary"
                                        size="lg"
                                        fullWidth
                                        className={PROVIDER_BUTTON}
                                    >
                                        <GoogleIcon className="size-5" />
                                        Continue with Google
                                    </Button>
                                </form>
                            )}

                            {showOidc && (
                                <form
                                    action={async () => {
                                        'use server';
                                        await rememberAttribution(attribution);
                                        await signIn('oidc', { redirectTo });
                                    }}
                                >
                                    <Button
                                        type="submit"
                                        variant="secondary"
                                        size="lg"
                                        fullWidth
                                        className={PROVIDER_BUTTON}
                                    >
                                        <KeyRound className="size-5" aria-hidden="true" />
                                        Continue with {oidcDisplayName()}
                                    </Button>
                                </form>
                            )}

                            {!showLocal && providerCount === 0 && (
                                <p className="text-sm text-danger">
                                    Sign-in is not configured. Enable local login (AUTH_LOCAL_ENABLED=true) or set
                                    AUTH_OIDC_*, AUTH_GITHUB_* or AUTH_GOOGLE_* on the server.
                                </p>
                            )}
                        </div>

                        {/* Ticks in `success`, the one glyph colour that is not a
                severity (theme.css). The site-wide assurances from the
                marketing CTA block (landing-page GetStartedActions.tsx),
                word for word. */}
                        <ul className="mt-7 space-y-2 text-sm text-ink-muted">
                            {ASSURANCES.map((item) => (
                                <li key={item} className="flex items-center gap-2">
                                    <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                                    {item}
                                </li>
                            ))}
                        </ul>

                        {/*
              Absolute links to the marketing site, opened in a new tab: the legal
              pages are canonical there, and navigating away mid-sign-in would
              drop the callbackUrl this page was reached with. The same-origin
              /terms and /privacy paths redirect here too (see next.config.ts).
              Links in `ink-muted` with an underline rather than accent blue:
              two more blue links would compete with the buttons above them
              for the eye.
            */}
                        {isCloud ? (
                            <p className="mt-8 text-xs leading-5 text-ink-muted">
                                New here? Your account is created on first sign-in. By continuing you agree to the{' '}
                                <a
                                    href="https://stackradar.io/terms"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline underline-offset-2 hover:text-ink transition-colors"
                                >
                                    Terms
                                </a>{' '}
                                and{' '}
                                <a
                                    href="https://stackradar.io/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline underline-offset-2 hover:text-ink transition-colors"
                                >
                                    Privacy Policy
                                </a>
                                .
                            </p>
                        ) : providerCount > 0 ? (
                            <p className="mt-8 text-xs leading-5 text-ink-muted">
                                New here? Your account is created on first sign-in.
                            </p>
                        ) : (
                            <p className="mt-8 text-xs leading-5 text-ink-muted">
                                No account? Ask your StackRadar administrator; accounts are created from the admin
                                dashboard.
                            </p>
                        )}

                        {/* The no-account door, quieter than the buttons: the live
                demo, for the reader who wants to see the dashboard before
                signing in. Not drawn when this page *is* the demo — there
                the route gate sends /login to /demo/enter, so a visitor
                never sees this page, but a link from the demo to itself is
                still wrong. */}
                        {isCloud && !isDemoMode() && (
                            <p className="mt-4 text-sm text-ink-muted">
                                Just want to look around?{' '}
                                <a href={DEMO_URL} className="font-medium text-accent hover:underline">
                                    Open the live demo
                                </a>
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Right: the proof panel. A rounded panel inset from the viewport
          edge (Semrush: 16px margin, 24px radius), washed in the accent at
          the top fading to the raised surface, with one card in the middle.
          One card, no carousel — Semrush's does not rotate either, and a
          reader who is about to click a button should not be watching
          something move.

          What the card says has to be true and checkable, which rules out
          a testimonial or a made-up percentage. It is the count of public
          Helm charts the public chart index (charts.stackradar.io) renders
          and scans nightly with the same pipeline the visitor is about to
          point at their own cluster. The figure is HAND-COPIED, not live,
          rounded down so it stays true for months; the marketing site shows
          the same number, so refresh both together:

            curl -sL https://charts.stackradar.io/charts | grep -oE '[0-9,]+ charts'
      */}
            <div className="hidden lg:block lg:p-4">
                <div className="flex h-full min-h-[calc(100vh-2rem)] items-center justify-center rounded-3xl bg-surface-raised border border-edge p-10 bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--accent-emphasis)_14%,transparent),transparent_70%)]">
                    <div
                        className="w-full max-w-sm rounded-xl border border-edge bg-surface-raised p-8 shadow-floating"
                        data-measured-on={CHART_INDEX_COUNT.measuredOn}
                    >
                        <p className="text-5xl font-light tabular-nums tracking-[-0.02em] text-ink">
                            {CHART_INDEX_COUNT.value}
                        </p>
                        <p className="mt-3 text-xl font-semibold leading-snug tracking-tight text-ink text-balance">
                            Public Helm charts scanned every night
                        </p>
                        <p className="mt-3 text-base leading-6 text-ink-muted">
                            The same pipeline that will watch your cluster runs across the whole public Helm ecosystem.
                            Not a demo dataset.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
