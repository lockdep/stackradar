import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createApiHeaders, getExpressUrl, handleApiError } from '@/lib/api-utils';
import { readEdition } from '@/lib/edition';
import { ATTRIBUTION_COOKIE, parseAttributionCookie } from '@/cloud';

/**
 * POST /api/user/setup - Set up a new user with a default organization
 * Called when user first accesses the dashboard after sign-in
 */
export async function POST(request: NextRequest) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // The ad-click parameters the login page tucked into a cookie for the
    // OAuth round trip (`lib/attribution.ts`). Forwarded once, on the call
    // that creates the account's org; the server ignores them for an account
    // that already has one. The cookie is cleared below on success only, so a
    // transient failure here gets another go on the retry. Cloud only: the
    // community edition has no campaign to credit and never set the cookie.
    const attribution = readEdition().isCloud
        ? parseAttributionCookie(request.cookies.get(ATTRIBUTION_COOKIE)?.value)
        : null;

    // Where the browser says it is: its IANA time zone (posted by the
    // provider that calls this route) and its first Accept-Language tag.
    // Forwarded with the attribution, on the same one call; the server
    // validates both as bounded labels and stores them beside the campaign
    // tags. No IP lookup happens anywhere.
    const body = (await request.json().catch(() => ({}))) as { timezone?: unknown };
    const timezone = typeof body.timezone === 'string' && body.timezone.length <= 64 ? body.timezone : undefined;
    const locale = firstLanguage(request.headers.get('accept-language'));
    const origin = { ...(timezone ? { timezone } : {}), ...(locale ? { locale } : {}) };

    try {
        const response = await fetch(`${getExpressUrl()}/api/users/setup`, {
            method: 'POST',
            headers: await createApiHeaders(session, request),
            body: JSON.stringify({
                userId: session.user.id,
                userName: session.user.name,
                userEmail: session.user.email,
                attribution: { ...attribution, ...origin },
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Unknown error' }));
            return NextResponse.json({ error: error.error || 'Failed to set up user' }, { status: response.status });
        }

        const data = await response.json();
        const result = NextResponse.json(data);
        if (attribution) {
            result.cookies.set(ATTRIBUTION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
        }
        return result;
    } catch (error) {
        return handleApiError(error);
    }
}

/** `nb-NO,nb;q=0.9,en;q=0.8` → `nb-NO`. The tag only, never the weights. */
function firstLanguage(header: string | null): string | undefined {
    const tag = header?.split(',')[0]?.split(';')[0]?.trim();
    return tag && /^[A-Za-z0-9-]{1,64}$/.test(tag) ? tag : undefined;
}
