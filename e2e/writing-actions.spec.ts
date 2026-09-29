import { test, expect, editor, newDocument, editorText, mod } from './fixtures';
import type { Page } from '@playwright/test';

async function selectParagraph(page: Page) {
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect(page.getByTestId('selection-menu')).toBeVisible();
}

const SENTENCE = 'This is really very important in order to succeed.';

test.describe('AI writing actions', () => {
  test('preview then accept, as one undo step', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type(SENTENCE, { delay: 5 });
    await selectParagraph(page);
    await page.getByTestId('action-shorter').click();
    const bar = page.getByTestId('preview-bar');
    await expect(bar).toHaveAttribute('data-status', 'done');
    // Nothing is replaced until accepted: the original is still in the document, struck through.
    expect((await editor(page).locator('.ink-diff-del').allTextContents()).join('')).toBe(SENTENCE);
    await expect(editor(page).locator('.ink-diff-ins')).toContainText('This is important to succeed.');
    await page.getByTestId('preview-accept').click();
    await expect.poll(() => editorText(page)).toBe('This is important to succeed.');
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => editorText(page)).toBe(SENTENCE);
  });

  test('discard leaves the text untouched', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type(SENTENCE, { delay: 5 });
    await selectParagraph(page);
    await page.getByTestId('action-improve').click();
    await expect(page.getByTestId('preview-bar')).toHaveAttribute('data-status', 'done');
    await page.getByTestId('preview-discard').click();
    await expect(page.getByTestId('preview-bar')).toHaveCount(0);
    expect(await editorText(page)).toBe(SENTENCE);
  });

  test.describe('slow streams', () => {
    test.use({ mock: { latencyMs: 2400, mode: 'ok' } });

    test('cancel mid-stream', async ({ page }) => {
      await newDocument(page);
      await page.keyboard.type(SENTENCE, { delay: 5 });
      await selectParagraph(page);
      await page.getByTestId('action-shorter').click();
      const bar = page.getByTestId('preview-bar');
      await expect(bar).toHaveAttribute('data-status', 'streaming');
      await page.getByTestId('preview-discard').click(); // "Stop"
      await expect(bar).toHaveCount(0);
      await page.waitForTimeout(3000);
      expect(await editorText(page)).toBe(SENTENCE);
      await expect(editor(page).locator('.ink-diff-ins')).toHaveCount(0);
    });

    test('editing the target range cancels the action; editing elsewhere does not', async ({ page }) => {
      await newDocument(page);
      await page.keyboard.type('First paragraph stays.', { delay: 5 });
      await page.keyboard.press('Enter');
      await page.keyboard.type(SENTENCE, { delay: 5 });
      await selectParagraph(page);
      await page.getByTestId('action-shorter').click();
      await expect(page.getByTestId('preview-bar')).toHaveAttribute('data-status', 'streaming');
      // Edit elsewhere: the preview survives.
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('End');
      await page.keyboard.type(' Yes.', { delay: 5 });
      await expect(page.getByTestId('preview-bar')).toBeVisible();
      // Edit inside the target: cancelled.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('X', { delay: 5 });
      await expect(page.getByTestId('preview-bar')).toHaveCount(0);
      await page.waitForTimeout(2500);
      expect(await editorText(page)).toBe(`First paragraph stays. Yes.\nTX${SENTENCE.slice(1)}`);
    });
  });

  test('continue writing streams ghost text; Tab accepts', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('The work began at dawn.', { delay: 5 });
    await page.keyboard.press(`${mod}+Shift+Enter`);
    await expect(page.getByTestId('preview-bar')).toHaveAttribute('data-status', 'done');
    await expect(editor(page).locator('.ink-ghost')).toContainText('And so the work went on');
    await page.keyboard.press('Tab');
    await expect.poll(() => editorText(page)).toBe('The work began at dawn. And so the work went on, one careful sentence at a time.');
  });

  test('continue writing is discarded by Escape', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('The work began at dawn.', { delay: 5 });
    await page.keyboard.press(`${mod}+Shift+Enter`);
    await expect(editor(page).locator('.ink-ghost')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor(page).locator('.ink-ghost')).toHaveCount(0);
    expect(await editorText(page)).toBe('The work began at dawn.');
  });

  test('summarize opens a side panel with Copy and Insert', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('The first paragraph explains the goal of the project in some detail for the reader.', { delay: 2 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('The second paragraph lists the risks and how the team plans to handle each one.', { delay: 2 });
    await page.keyboard.press(`${mod}+k`);
    await page.getByTestId('switcher-input').fill('summarize');
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('summary-panel');
    await expect(panel).toContainText('The first paragraph explains the goal');
    await expect(panel.getByRole('button', { name: 'Copy' })).toBeVisible();
    await panel.getByTestId('summary-insert').click();
    await expect(editor(page).locator('ul li')).toHaveCount(2);
  });
});
