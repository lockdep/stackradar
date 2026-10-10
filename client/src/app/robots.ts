import type { MetadataRoute } from "next";
import { isDemoMode } from "@/lib/demo";

/**
 * The dashboard is an authenticated app; the indexable surface is
 * stackradar.io, and every page here carries `noindex, nofollow` (the
 * layout's robots metadata, plus an `X-Robots-Tag` header in demo mode).
 *
 * The live demo *allows* crawling, deliberately. A robots.txt disallow hides
 * the noindex: Google cannot read a directive on a page it may not fetch,
 * and a blocked URL that enough pages link to (the landing page, the launch
 * posts, the org README all link demo.stackradar.io) still gets indexed as
 * a bare "no information is available" result. Letting the crawler in is
 * what keeps the host out of the results. There is nothing to crawl anyway:
 * every page but `/login` and `/demo/enter` needs the session cookie, which
 * a crawler does not carry between fetches, so it sees the entry redirect,
 * the login page and the noindex on each. The indexable home of the demo is
 * stackradar.io/demo. (docs/live-demo/ step 02.)
 *
 * The real app keeps the disallow: it is linked from nowhere public but the
 * landing's sign-in links, and a crawler has no business at /login.
 */
export default function robots(): MetadataRoute.Robots {
    if (isDemoMode()) return { rules: { userAgent: "*", allow: "/" } };
    return { rules: { userAgent: "*", disallow: "/" } };
}
