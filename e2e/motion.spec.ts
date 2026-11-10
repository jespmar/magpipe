import { expect, test } from '@playwright/test';

// Motion is opt-in (CLAUDE.md) and a loop means live status (Arc): the orb's orbit turns only
// while agents are flying, and never for people who have asked for less motion.

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('nothing animates on Home when the system asks for less motion', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'No agents flying right now' }),
    ).toBeVisible();
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
});

test.describe('motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the orb rests while nothing is flying', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'No agents flying right now' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'The nest' })).toContainText(
      'No agents flying right now',
    );
    const running = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
});
