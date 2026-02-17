/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: [],
  turbopack: {
    resolveAlias: {
      'next/dist/server/web/exports/next-response': 'next/dist/server/web/spec-extension/response',
      'next/dist/server/web/exports/next-request': 'next/dist/server/web/spec-extension/request',
    },
  },
};

export default nextConfig;
