export const NAV_LINKS = [
  { href: '/agents', label: 'Agents' },
  { href: '/runs', label: 'Runs' },
  { href: '/tools', label: 'Tools' },
  { href: '/memory', label: 'Memory' },
  { href: '/factory', label: 'Factory' },
] as const;

/** `/runs/flight_8f3a21` keeps "Runs" active; `/` activates nothing. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
