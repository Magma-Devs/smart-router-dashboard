import { NextResponse } from "next/server";

// NEXT_PUBLIC_* values are inlined into every bundle at BUILD time, so on
// their own they can't vary per deployment. DASHBOARD_* are read from the
// container environment at request time, letting one published image serve
// any host: set DASHBOARD_API_URL when the api isn't on localhost:8000.
export const dynamic = "force-dynamic";

/** Runtime config surfaced to the browser so one image works across envs. */
export function GET() {
  return NextResponse.json({
    apiUrl:
      process.env.DASHBOARD_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:8000",
    localMode:
      (process.env.DASHBOARD_LOCAL_MODE ?? process.env.NEXT_PUBLIC_LOCAL_MODE) === "true",
    // Lets the browser-side api-client know whether to wait for the
    // session bridge and attach a Bearer token (see lib/api-client.ts).
    authMode: process.env.AUTH_MODE === "enabled" ? "enabled" : "disabled",
  });
}
