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
    // managed (we host, email works) vs onprem (customer hosts, no mail server
    // and never will). It forks every credential-delivery path, so it has to be
    // a RUNTIME value — NEXT_PUBLIC_* is baked in at build time and one
    // published image has to serve both shapes.
    deploymentMode: process.env.DEPLOYMENT_MODE === "managed" ? "managed" : "onprem",
    // Base URL of the Grafana that hosts the logs board — the "View full logs"
    // button links here. Set DASHBOARD_GRAFANA_URL in the container env to point
    // at any Grafana (the bundled `logs` profile publishes it on :3001). Default
    // matches that profile so the button works out of the box locally.
    grafanaUrl:
      process.env.DASHBOARD_GRAFANA_URL ??
      process.env.NEXT_PUBLIC_GRAFANA_URL ??
      "http://localhost:3001",
  });
}
