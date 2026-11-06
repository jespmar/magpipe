// After `next build`: make .next/standalone self-contained (static assets, public/, migrations) and
// strip env files so build-machine secrets never ship inside the desktop bundle.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error(
    'prepare-standalone: .next/standalone/server.js missing — is output: "standalone" set?',
  );
  process.exit(1);
}

fs.cpSync(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'), {
  recursive: true,
});
if (fs.existsSync(path.join(root, 'public'))) {
  fs.cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
}

// Database migrations are applied by the server on start-up (lib/db/index.ts).
fs.cpSync(path.join(root, 'drizzle'), path.join(standalone, 'drizzle'), { recursive: true });

// A local dev database must never ship.
fs.rmSync(path.join(standalone, '.magpipe'), { recursive: true, force: true });

for (const name of fs.readdirSync(standalone)) {
  if (name.startsWith('.env')) {
    fs.rmSync(path.join(standalone, name));
    console.log(`prepare-standalone: removed ${name} from the bundle`);
  }
}
console.log('prepare-standalone: .next/standalone is ready');
