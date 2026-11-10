import { Logo } from '@/components/Logo';

/**
 * The orchestrator core (spec §5.3), quieter: the magpie on its white disc inside two hairline
 * rings, with one dashed orbit that turns slowly. The screen's one piece of orchestrated motion,
 * and only for people who have not asked for less of it. Decorative; the heading beside it
 * carries the meaning.
 */
export function OrchestratorOrb() {
  return (
    <div
      aria-hidden
      className="relative aspect-square w-[220px] max-w-full shrink-0 wide:w-[300px]"
    >
      <div className="absolute -inset-4 rounded-pill border border-dashed border-cyan/40 motion-safe:animate-orbit" />
      <div className="absolute inset-0 rounded-pill border border-hairline" />
      <div className="absolute inset-[16%] rounded-pill border border-cyan/30" />
      <div className="absolute inset-[33%] flex items-center justify-center rounded-pill bg-ink-strong">
        <Logo size={44} label={null} id="mp-wing-orb" className="h-auto w-[62%]" />
      </div>
    </div>
  );
}
