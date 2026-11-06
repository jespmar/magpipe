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
};

export default nextConfig;
