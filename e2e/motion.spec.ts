import { expect, test } from '@playwright/test';

// Motion is opt-in (CLAUDE.md): decorative animation runs only for people who have not asked
// for less of it. The orb on Home is the product's one orchestrated motion.

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('nothing animates on Home when the system asks for less motion', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Birds on the wire' })).toBeVisible();
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
});

test.describe('motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the orb turns on Home when motion is welcome', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Birds on the wire' })).toBeVisible();
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    );
    expect(running).toBeGreaterThan(0);
  });
});
