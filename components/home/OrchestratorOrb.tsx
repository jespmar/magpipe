import { clsx } from 'clsx';
import { Logo } from '@/components/Logo';

/**
 * The orchestrator core (spec §5.3), quieter: the magpie on its white disc inside two hairline
 * rings and one dashed orbit. The orbit turns only while agents are flying (a loop means live
 * status, nothing else) and only for people who have not asked for less motion. Decorative; the
 * heading beside it carries the meaning.
 */
export function OrchestratorOrb({ live }: { live: boolean }) {
  return (
    <div
      aria-hidden
      className="relative aspect-square w-[220px] max-w-full shrink-0 wide:w-[300px]"
    >
      <div
        className={clsx(
          'absolute -inset-4 rounded-pill border border-dashed border-cyan/40',
          live && 'motion-safe:animate-orbit',
        )}
      />
      <div className="absolute inset-0 rounded-pill border border-hairline" />
      <div className="absolute inset-[16%] rounded-pill border border-cyan/30" />
      <div className="absolute inset-[33%] flex items-center justify-center rounded-pill bg-ink-strong">
        <Logo size={44} label={null} id="mp-wing-orb" className="h-auto w-[62%]" />
      </div>
    </div>
  );
}
