import { clsx } from 'clsx';

type LogoProps = {
  /** Rendered width of the bird in px (height follows the 820×700 artwork). */
  size?: number;
  /** Put the bird on a white disc, as in the nav and the orchestrator core. */
  onDisc?: boolean;
  /** Disc diameter in px when `onDisc` (defaults to 1.5× size). */
  discSize?: number;
  /** Unique per placement — the wing gradient is referenced by id. */
  id?: string;
  /** Accessible name. Pass `null` for a decorative logo. */
  label?: string | null;
  className?: string;
};

/** The dark magpie with white plumage and the sheen wing (public/brand/magpipe-magpie-logo-03.svg). */
export function Logo({
  size = 24,
  onDisc = false,
  discSize,
  id = 'mp-wing',
  label = 'Magpipe',
  className,
}: LogoProps) {
  const bird = (
    <svg
      width={size}
      height={Math.round((size * 700) / 820)}
      viewBox="55 73 820 700"
      fill="none"
      {...(label && !onDisc ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={onDisc ? undefined : className}
    >
      <defs>
        {/* The wing is the brand's --g-sheen ramp (emerald → teal → cyan). */}
        <linearGradient id={id} x1="173" y1="581" x2="629" y2="361" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--sheen-emerald)" />
          <stop offset=".55" stopColor="var(--sheen-teal)" />
          <stop offset="1" stopColor="var(--sheen-cyan)" />
        </linearGradient>
      </defs>
      <path
        d="M85 746 C96 716 179 634 282 555 L173 583 C236 490 348 365 447 289 C483 241 518 159 567 116 C605 83 650 87 734 119 C770 117 816 130 842 152 C789 168 735 186 725 215 C711 244 720 290 733 338 C750 411 724 499 680 557 C647 595 608 617 561 627 L554 642 L608 714 H643 C659 714 670 720 676 734 H439 C446 722 456 715 467 714 H500 L440 636 C417 627 402 617 386 611 C367 602 355 609 347 616 L285 677 C235 721 193 746 170 741 C159 749 145 749 132 745 C109 751 90 751 85 746 Z"
        fill="#101010"
      />
      <path
        d="M409 412 C469 352 567 295 614 301 C674 302 705 360 699 430 C695 510 653 562 600 589 C547 614 484 616 451 591 C439 582 432 563 428 548 C531 513 597 445 628 362 C556 388 490 405 409 412 Z"
        fill="#ffffff"
      />
      <path
        d="M173 581 C231 495 275 439 328 421 C368 410 385 409 413 409 C492 404 565 380 629 361 C599 432 547 465 481 495 C372 545 255 571 173 581 Z"
        fill={`url(#${id})`}
      />
      <path d="M483 628 H513 L582 713 H528 L477 645 Z" fill="#ffffff" />
      <circle cx="670" cy="152" r="15" fill="#ffffff" />
    </svg>
  );

  if (!onDisc) return bird;

  const d = discSize ?? Math.round(size * 1.5);
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-pill bg-ink-strong',
        className,
      )}
      style={{ width: d, height: d }}
      {...(label ? { role: 'img', 'aria-label': label } : {})}
    >
      {bird}
    </span>
  );
}
