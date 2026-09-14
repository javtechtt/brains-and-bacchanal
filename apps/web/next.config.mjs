/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them itself.
  transpilePackages: ['@bb/protocol', '@bb/ui-tokens'],
  webpack: (config) => {
    // Resolve @bb/* to TypeScript source via the "bb-source" export condition,
    // so the web app always builds against current package code.
    config.resolve.conditionNames = ['bb-source', ...(config.resolve.conditionNames ?? [])];
    return config;
  },
};

export default nextConfig;
