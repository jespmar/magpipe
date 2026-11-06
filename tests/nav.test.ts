import { describe, expect, it } from 'vitest';
import { isActive } from '@/lib/nav';

describe('isActive', () => {
  it('matches the section and its children', () => {
    expect(isActive('/runs', '/runs')).toBe(true);
    expect(isActive('/runs/flight_8f3a21', '/runs')).toBe(true);
  });

  it('does not match prefixes of other words or the home page', () => {
    expect(isActive('/runsheet', '/runs')).toBe(false);
    expect(isActive('/', '/agents')).toBe(false);
    expect(isActive('/agents', '/')).toBe(false);
  });
});
