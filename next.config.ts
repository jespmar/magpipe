import type { NextConfig } from 'next';
import pkg from './package.json' with { type: 'json' };

const nextConfig: NextConfig = {
  // `standalone` gives a self-contained server (server.js + traced node_modules) that the
  // Electron main process boots in a utility process. Vercel ignores it and deploys as usual.
  output: 'standalone',
  poweredByHeader: false,
  // PGlite loads its WebAssembly and data files relative to its own module — it must not be
  // bundled. Standalone tracing copies the package (wasm included) into the server bundle.
  serverExternalPackages: ['@electric-sql/pglite'],
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  webpack(config, { nextRuntime, webpack }) {
    // `instrumentation.ts` only boots the engine on the Node runtime, but the edge compiler
    // still follows its dynamic import and cannot bundle `node:child_process` (the sandbox).
    // In production the guard is tree-shaken; in dev it is not, so the edge build is told to
    // skip the module. The import never runs there.
    if (nextRuntime === 'edge') {
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^\.\/lib\/engine\/boot$/ }));
    }
    return config;
  },
};

export default nextConfig;
