import { NextResponse } from "next/server";

/** Runtime config surfaced to the browser so one image works across envs. */
export function GET() {
  return NextResponse.json({
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
    localMode: process.env.NEXT_PUBLIC_LOCAL_MODE === "true",
  });
}
