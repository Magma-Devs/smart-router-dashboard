/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'info-mainnet.lavanet.xyz',
        pathname: '/icons/**',
      },
    ],
  },
}

module.exports = nextConfig 