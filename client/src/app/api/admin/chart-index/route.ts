import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRequestId, handleApiError } from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";

/**
 * `GET /api/admin/chart-index` — the Chart Index admin tab's data.
 *
 * An explicit route, not the catch-all, because its upstream is not
 * Express: the chart index (`charts/`) is its own app with its own
 * database, and the only thing it exposes about that database's *state*
 * is `GET /internal/status` on the charts site, keyed by
 * `STATUS_SERVICE_KEY` (charts `src/app/internal/status/route.ts`). This
 * route is that call with the product's session in front of it — the
 * same admin gate the catch-all applies to `admin/*` — and nothing else:
 * the payload streams back as the charts site shaped it.
 *
 * `CHARTS_STATUS_URL` is the site's in-cluster Service (the gitops
 * `client-config` ConfigMap; `http://localhost:3002` locally) and
 * `CHARTS_STATUS_KEY` the shared key (`client-secrets`). Both unset is
 * the ordinary state of an environment without a chart index, so it is
 * a 503 with a message the tab shows, not a crash.
 */

const log = createLogger("api.admin.chart-index");

const UPSTREAM_TIMEOUT_MS = 30_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const base = process.env.CHARTS_STATUS_URL;
  const key = process.env.CHARTS_STATUS_KEY;
  if (!base || !key) {
    // Name the missing half: the URL comes from the ConfigMap, the key from
    // the hand-made secret, and they go missing for different reasons.
    const missing = [!base && "CHARTS_STATUS_URL", !key && "CHARTS_STATUS_KEY"].filter(Boolean).join(" and ");
    return NextResponse.json(
      { error: `The chart index is not configured for this environment: ${missing} ${!base && !key ? "are" : "is"} unset on the client.` },
      { status: 503 },
    );
  }

  const reqId = getRequestId(request);
  const url = `${base.replace(/\/+$/, "")}/internal/status`;

  try {
    const response = await fetch(url, {
      headers: { "X-Status-Key": key, "X-Request-Id": reqId, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    log.info({ reqId, status: response.status, userId: session.user.id }, "Fetched chart index status");

    if (!response.ok) {
      const reason =
        response.status === 401
          ? "the charts site rejected CHARTS_STATUS_KEY"
          : response.status === 404
            ? "the charts site has no STATUS_SERVICE_KEY set, so its status route is not enabled"
            : response.status === 503
              ? "the charts site could not read its database"
              : `the charts site answered ${response.status}`;
      return NextResponse.json({ error: `Chart index status unavailable: ${reason}.` }, { status: 502 });
    }

    return new NextResponse(response.body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error, reqId);
  }
}
