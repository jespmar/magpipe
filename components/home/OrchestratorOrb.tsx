import { Logo } from '@/components/Logo';

/**
 * The orchestrator core (spec §5.3): a white disc with the magpie, three concentric cyan rings,
 * a dashed orbit (16 s) and a counter-rotating conic arc (26 s). 260 px on desktop, 400 at wide;
 * the rings are percentages so one markup scales. Pure CSS; motion only for people who have not
 * asked for less of it. Decorative — the heading beside it carries the meaning.
 */
export function OrchestratorOrb() {
  return (
    <div
      aria-hidden
      className="relative aspect-square w-[260px] max-w-full shrink-0 wide:w-[400px]"
    >
      <div className="absolute -inset-[18px] rounded-pill border border-dashed border-cyan/35 motion-safe:animate-orbit" />
      <div className="absolute -inset-1.5 rounded-pill orb-arc motion-safe:animate-orbit-reverse" />
      <div className="absolute inset-0 rounded-pill border border-cyan/25 bg-cyan/4 motion-safe:animate-ring-pulse" />
      <div className="absolute inset-[12.3%] rounded-pill border border-cyan/40 bg-cyan/7" />
      <div className="absolute inset-[24.6%] rounded-pill border border-cyan/60 bg-cyan/12" />
      <div className="absolute inset-[36.9%] flex items-center justify-center rounded-pill bg-accent shadow-[0_0_40px_rgba(34,193,220,0.35)] wide:shadow-[0_0_60px_rgba(34,193,220,0.35)]">
        <Logo size={44} label={null} id="mp-wing-orb" className="h-auto w-[62%]" />
      </div>
    </div>
  );
}
