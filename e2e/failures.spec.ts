import { test, expect, underline, newDocument, editorText, verifySuggestions } from './fixtures';

test.describe('failure handling', () => {
  test.describe('provider in error mode', () => {
    // The browser logs the deliberate 5xx responses; nothing else may reach the console.
    test.use({ mock: { latencyMs: 50, mode: 'error' }, allowConsole: [/Failed to load resource: the server responded with a status of 50[23]/] });

    test('local checks continue, the status stays calm, nothing crashes', async ({ page }) => {
      await newDocument(page);
      await page.keyboard.type('I recieve teh mail. ', { delay: 5 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('Second paragraph is here. ', { delay: 5 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('Third one too. And a fourth sentence. ', { delay: 5 });
      await expect(underline(page, 'recieve')).toBeVisible({ timeout: 15_000 });
      await expect(underline(page, 'teh')).toBeVisible();
      // After repeated failures the AI tier pauses quietly; local checks keep working.
      await expect(page.getByTestId('ai-mode')).toHaveAttribute('data-mode', 'paused', { timeout: 15_000 });
      await expect(page.getByTestId('ai-mode')).toContainText('local checks on');
      await page.keyboard.type('More text, still typing fine.', { delay: 5 });
      expect(await editorText(page)).toContain('Third one too. And a fourth sentence. More text, still typing fine.');
      await verifySuggestions(page);
    });

    test('a failed writing action shows a short message with Retry', async ({ page }) => {
      await newDocument(page);
      await page.keyboard.type('Make this sentence better please.', { delay: 5 });
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.getByTestId('action-improve').click();
      const bar = page.getByTestId('preview-bar');
      await expect(bar).toHaveAttribute('data-status', 'error');
      await expect(bar).toContainText('Try again?');
      await expect(page.getByTestId('preview-retry')).toBeVisible();
      await page.getByTestId('preview-discard').click();
      expect(await editorText(page)).toBe('Make this sentence better please.');
    });
  });

  test.describe('malformed model output', () => {
    test.use({ mock: { latencyMs: 50, mode: 'malformed' } });

    test('is dropped silently (no error, no bogus suggestions)', async ({ page }) => {
      await newDocument(page);
      await page.keyboard.type('Their is a problem. We could of known. ', { delay: 5 });
      await page.waitForTimeout(2500);
      await expect(underline(page, 'Their is')).toHaveCount(0);
      await expect(page.getByTestId('ai-mode')).toHaveAttribute('data-mode', 'ai');
    });
  });

  test('local-only mode sends nothing and says so', async ({ page }) => {
    await newDocument(page);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('setting-local-only').check();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ai-mode')).toHaveText('Local checks only');
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/ai/')) requests.push(r.url());
    });
    await page.getByTestId('editor').click();
    await page.keyboard.type('Their is a problem. I recieve mail. ', { delay: 5 });
    await expect(underline(page, 'recieve')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(requests).toEqual([]);
    await expect(underline(page, 'Their is')).toHaveCount(0);
  });

  test('turning AI off for one document removes AI suggestions', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('Their is a dog. ', { delay: 5 });
    await expect(underline(page, 'Their is')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('open-settings').click();
    await page.getByTestId('setting-doc-ai').uncheck();
    await page.keyboard.press('Escape');
    await expect(underline(page, 'Their is')).toHaveCount(0);
    await expect(page.getByTestId('ai-mode')).toContainText('AI off for this document');
  });
});
