import { NextResponse } from 'next/server';

/**
 * Runtime configuration API endpoint
 *
 * This endpoint serves environment variables at runtime, allowing them to be
 * passed from outside the container/build process.
 *
 * Unlike NEXT_PUBLIC_* variables which are embedded at build time, these
 * values are read from the server's environment at request time.
 */
export async function GET() {
  return NextResponse.json({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
    NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN || 'localhost',
    NEXT_PUBLIC_PORT: process.env.NEXT_PUBLIC_PORT || '3000',
  });
}
