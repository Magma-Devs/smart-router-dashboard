/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // The browser-facing API base is injected at runtime via a small route, but
  // we also expose it at build for SSR fetches.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  },
};

export default nextConfig;
