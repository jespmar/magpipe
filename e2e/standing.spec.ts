import { expect, test } from '@playwright/test';

// The orchestrator's rules and the standing instructions (D34). Runs after shell.spec.ts has
// loaded the demo data (specs run in file order against one database), and only reads.

test('settings shows the orchestrator’s rules and the decisions that reach every plan', async ({
  page,
}) => {
  await page.goto('/settings#orchestrator');
  const section = page.getByRole('region', { name: 'Orchestrator' });
  await expect(section.getByRole('heading', { level: 2, name: 'Orchestrator' })).toBeFocused();

  const rules = section.getByRole('region', { name: 'Orchestrator rules' });
  await expect(rules).toContainText('You are Magpipe, the orchestrator');
  await expect(rules.getByRole('button', { name: 'Copy rules' })).toBeVisible();

  const standing = section.getByRole('region', { name: 'Standing instructions' });
  await expect(
    standing.getByText('Every entry here reaches every plan the orchestrator makes.'),
  ).toBeVisible();
  const decisions = standing.getByRole('list', { name: 'Decisions' });
  await expect(decisions.getByRole('link', { name: 'pr.merge_policy' })).toBeVisible();
  await expect(decisions.getByText('Reviewer approves, humans merge')).toBeVisible();

  // An entry opens in Memory, on the decisions namespace, with the same note above it.
  await decisions.getByRole('link', { name: 'pr.merge_policy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole('complementary', { name: 'Reviewer approves, humans merge' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Namespaces' })
      .getByRole('button', { name: /^Decisions/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByText('Every entry here reaches every plan the orchestrator makes.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'See the orchestrator’s rules' })).toHaveAttribute(
    'href',
    '/settings#orchestrator',
  );

  // Another namespace carries no such note.
  await page
    .getByRole('navigation', { name: 'Namespaces' })
    .getByRole('button', { name: /^Facts/ })
    .click();
  await expect(page.getByText('Every entry here reaches every plan')).toHaveCount(0);
});
