/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // No page uses next/image, and the published image depends on that: the
  // build stage runs on the amd64 runner and traces its own sharp binary
  // into the standalone output (apps/web/Dockerfile), so on arm64 the image
  // optimizer would fail to load it. Unoptimized images never load sharp.
  images: { unoptimized: true },
  // The browser-facing API base is injected at runtime via a small route, but
  // we also expose it at build for SSR fetches.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  },
};

export default nextConfig;
