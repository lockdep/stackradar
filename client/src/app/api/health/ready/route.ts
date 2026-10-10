import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getAuthConfigProblems } from "@/lib/auth-health";

// Readiness probe - checks if the service can handle traffic
// Verifies database connection for Auth.js session management, and that the
// Auth.js configuration itself is intact — a pod that cannot authenticate
// anyone should leave the Service rather than serve a broken sign-in.
// See lib/auth-health.ts for the reasoning (GHSA-8fpg-xm3f-6cx3).
export async function GET() {
  const checks: {
    database: "ok" | "error";
    authConfig: "ok" | "error";
    error?: string;
    authProblems?: string[];
  } = {
    database: "ok",
    authConfig: "ok",
  };

  try {
    // Verify database connection with a simple query
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    checks.database = "error";
    checks.error = error instanceof Error ? error.message : "Unknown database error";
  }

  const authProblems = getAuthConfigProblems();
  if (authProblems.length > 0) {
    checks.authConfig = "error";
    // Names of missing variables only — never their values.
    checks.authProblems = authProblems;
  }

  const isReady = checks.database === "ok" && checks.authConfig === "ok";

  return NextResponse.json(
    {
      status: isReady ? "ready" : "not_ready",
      checks,
    },
    { status: isReady ? 200 : 503 }
  );
}

