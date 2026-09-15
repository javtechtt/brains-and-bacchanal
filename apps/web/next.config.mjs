/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them itself.
  transpilePackages: ['@bb/protocol', '@bb/ui-tokens'],
  webpack: (config) => {
    // Resolve @bb/* to TypeScript source via the "bb-source" export condition,
    // so the web app always builds against current package code.
    config.resolve.conditionNames = ['bb-source', ...(config.resolve.conditionNames ?? [])];

    // Those TypeScript sources import each other as "./envelope.js" — the
    // extension Node requires for real ESM, and what the built output uses.
    // Reading the SOURCE instead means webpack must map those specifiers back
    // to the .ts files that will actually satisfy them.
    //
    // Until Phase 4 nothing here imported a runtime VALUE from @bb/protocol
    // (only `import type`, which erases before webpack sees it), so this gap
    // existed but could not bite. Sharing real constants — intent names, team
    // ids, the room-code alphabet — is what surfaced it, and sharing them is
    // the point of a shared protocol package.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };

    return config;
  },
};

export default nextConfig;
