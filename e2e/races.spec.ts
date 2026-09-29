import { test, expect, editor, underline, newDocument, editorText, verifySuggestions } from './fixtures';

type Log = { event: string; data: Record<string, unknown> }[];
const readLog = (page: import('@playwright/test').Page) =>
  page.evaluate(() => ((window as unknown as { __inkwellLog?: Log }).__inkwellLog ?? []).map((e) => ({ event: e.event, data: e.data })));

test.describe('races and cancellation', () => {
  test.use({ mock: { latencyMs: 1500, mode: 'ok' } });

  test('rapid typing with slow AI responses in flight: exact text, no cursor jumps, no stale suggestions', async ({ page }) => {
    await newDocument(page);
    const paragraphs = [
      'Their is a first paragraph that we type quickly. It could of been slower.',
      'The second one arrives while the first is still being checked by the slow model.',
      'A third paragraph, with alot of words, finishes the burst. Then we stop.',
    ];
    for (let i = 0; i < paragraphs.length; i++) {
      await page.keyboard.type(paragraphs[i]!, { delay: 12 });
      if (i < paragraphs.length - 1) await page.keyboard.press('Enter');
      // Sentence completions fire requests; keep typing while they are in flight.
    }
    // Everything typed landed exactly where it was typed (a jumping cursor would scramble this).
    expect(await editorText(page)).toBe(paragraphs.join('\n'));
    const sel = await page.evaluate(() => (window as unknown as { __inkwell: { selection(): { from: number; size: number } } }).__inkwell.selection());
    expect(sel.from).toBe(sel.size - 1); // caret still at the end of the last paragraph

    // Let the slow responses land, then check every suggestion against the text it claims.
    await expect(underline(page, 'could of')).toBeVisible({ timeout: 10_000 });
    await expect(underline(page, 'Their is')).toBeVisible({ timeout: 10_000 });
    await verifySuggestions(page);
    expect(await editorText(page)).toBe(paragraphs.join('\n'));
  });

  test('editing a paragraph mid-request aborts it and old results never appear', async ({ page }) => {
    await newDocument(page);
    const aborted: string[] = [];
    page.on('requestfailed', (r) => {
      if (r.url().includes('/api/ai/check')) aborted.push(r.failure()?.errorText ?? '');
    });
    const started = page.waitForRequest((r) => r.url().includes('/api/ai/check'));
    await page.keyboard.type('Their is a problem here. ', { delay: 10 }); // sentence completion → request
    await started;
    // While that request is in flight, rewrite the paragraph.
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('There is no problem here now.', { delay: 10 });

    await expect.poll(() => aborted.length).toBeGreaterThan(0);
    expect(aborted.join(' ')).toMatch(/ABORTED|aborted|cancel/i);
    const log = await readLog(page);
    expect(log.some((e) => e.event === 'ai.abort')).toBe(true);

    // Wait out the slow model: nothing from the old version may show up.
    await page.waitForTimeout(3500);
    await expect(underline(page, 'Their is')).toHaveCount(0);
    await expect(underline(page, 'There is')).toHaveCount(0);
    await verifySuggestions(page);
    expect(await editorText(page)).toBe('There is no problem here now.');
  });

  test('never flags the word being typed', async ({ page }) => {
    await newDocument(page);
    // Make sure the spelling engine is live first, or the check below would pass vacuously.
    await page.keyboard.type('We recieve mail.', { delay: 5 });
    await expect(underline(page, 'recieve')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('I am writting', { delay: 20 });
    await page.waitForTimeout(900);
    await expect(underline(page, 'writting')).toHaveCount(0);
    await page.keyboard.type(' ', { delay: 20 }); // word boundary
    await expect(underline(page, 'writting')).toBeVisible({ timeout: 10_000 });
    await expect(editor(page)).toContainText('I am writting');
  });
});
