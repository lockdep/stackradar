import { NextResponse } from 'next/server';

// Liveness probe - just checks if the process is alive
// Should NOT check external dependencies
export async function GET() {
    return NextResponse.json({ status: 'ok' });
}
