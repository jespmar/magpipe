import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` writes SQL migrations to drizzle/. They ship with the app and are
// applied on start-up (lib/db/index.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
});
