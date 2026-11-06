/** "4 agents in the database" — proves the database wiring on scaffold screens. */
export function SeedCount({ count, noun }: { count: number | null; noun: string }) {
  if (count === null) return null;
  return (
    <p className="font-mono text-code text-mute">
      {count} {noun} in the database{count === 0 ? ' — run npm run seed' : ''}
    </p>
  );
}
