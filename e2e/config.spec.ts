import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The config file editor (D48): magpipe.env edited in Settings. The e2e server names its own
// file, as the desktop app does (playwright.config.ts).
const CONFIG = path.resolve('.magpipe/e2e-config/magpipe.env');

test('settings edits the config file, refuses what it should, and says what waits for a restart', async ({
  page,
}) => {
  fs.rmSync(path.dirname(CONFIG), { recursive: true, force: true });
  await page.goto('/settings#config');
  await page.waitForLoadState('networkidle');
  const section = page.getByRole('region', { name: 'Config file' });
  await expect(section.getByText(CONFIG)).toBeVisible({ timeout: 15_000 });
  const editor = section.getByLabel('magpipe.env');
  const status = section.getByRole('status');

  await editor.fill('# e2e\nMAGPIPE_REGION=e2e-studio\n');
  await expect(section.getByText('Unsaved changes.')).toBeVisible();
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(status).toContainText(/^Saved\. A restart applies .*MAGPIPE_REGION/, {
    timeout: 15_000,
  });
  expect(fs.readFileSync(CONFIG, 'utf8')).toBe('# e2e\nMAGPIPE_REGION=e2e-studio\n');
  await expect(section.getByText(/Saved but not in use yet: .*MAGPIPE_REGION/)).toBeVisible();
  // Not the desktop app here: there is no restart button, only the words.
  await expect(section.getByRole('button', { name: 'Restart Magpipe' })).toHaveCount(0);
  await expect(section.getByText(/Restart Magpipe to apply them\./)).toBeVisible();

  // A value the key does not take is refused; the file stays as it was.
  await editor.fill('MAGPIPE_MODEL_BACKEND=openai\n');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(status).toContainText('MAGPIPE_MODEL_BACKEND takes claude-code or api, not openai.');
  expect(fs.readFileSync(CONFIG, 'utf8')).toBe('# e2e\nMAGPIPE_REGION=e2e-studio\n');

  // Changed elsewhere since it was opened: refused, and Reload brings the file in as it is.
  fs.writeFileSync(CONFIG, '# edited elsewhere\nMAGPIPE_REGION=e2e-studio\n');
  await editor.fill('MAGPIPE_REGION=mine\n');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(status).toContainText('The file changed outside Magpipe since you opened it.');
  await section.getByRole('button', { name: 'Discard changes' }).click();
  await expect(editor).toHaveValue('# edited elsewhere\nMAGPIPE_REGION=e2e-studio\n');
});
