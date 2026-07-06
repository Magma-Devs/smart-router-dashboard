import { handlers } from "@/auth";

/**
 * Auth.js v5 route handlers. In AUTH_MODE=disabled these endpoints have
 * no reason to exist — return 404 so probing /api/auth/* reveals nothing
 * and nothing accidentally initializes Auth.js without a secret.
 */
const authEnabled = process.env.AUTH_MODE === "enabled";

const notFound = () => new Response("Not Found", { status: 404 });

export const GET = authEnabled ? handlers.GET : notFound;
export const POST = authEnabled ? handlers.POST : notFound;
