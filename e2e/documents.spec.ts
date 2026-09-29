import { test, expect, editor, newDocument, editorText } from './fixtures';

test.describe('documents and persistence', () => {
  test('autosave, then reload restores the document and the cursor', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('The quick brown fox.', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('Jumps over the dog.', { delay: 5 });
    // Put the cursor right after "brown".
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    for (let i = 0; i < 'The quick brown'.length; i++) await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    await page.waitForTimeout(1100); // view state (cursor) is saved ~800ms after it settles

    await page.reload();
    await expect(editor(page)).toContainText('Jumps over the dog.');
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type(' big', { delay: 5 });
    await expect.poll(() => editorText(page)).toBe('The quick brown big fox.\nJumps over the dog.');
  });

  test('rename, search, delete with undo', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('Notes about the lighthouse keeper.', { delay: 5 });
    await page.getByTestId('doc-title').fill('Lighthouse');
    await expect(page.getByTestId('doc-item').filter({ hasText: 'Lighthouse' })).toBeVisible();

    await page.getByTestId('new-document').click();
    await page.getByTestId('editor').click();
    await page.keyboard.type('A different story about gardens.', { delay: 5 });
    await page.getByTestId('doc-title').fill('Gardens');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');

    // Search by content.
    await page.getByTestId('doc-search').fill('keeper');
    await expect(page.getByTestId('doc-item')).toHaveCount(1);
    await expect(page.getByTestId('doc-item')).toContainText('Lighthouse');
    await page.getByTestId('doc-search').fill('nothing-matches-this');
    await expect(page.getByText('Nothing matches')).toBeVisible();
    await page.getByTestId('doc-search').fill('');
    await expect(page.getByTestId('doc-item')).toHaveCount(2);

    // Delete with undo.
    const row = page.locator('.ink-docitem', { hasText: 'Gardens' });
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await expect(page.getByTestId('doc-item')).toHaveCount(1);
    await page.getByTestId('toast-action').click();
    await expect(page.getByTestId('doc-item')).toHaveCount(2);
    await expect(editor(page)).toContainText('gardens');

    // Delete for real; it's gone after reload.
    await row.hover();
    await row.getByTestId('doc-delete').click();
    await expect(page.getByTestId('doc-item')).toHaveCount(1);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByTestId('doc-item')).toHaveCount(1);
    await expect(page.getByTestId('doc-item')).toContainText('Lighthouse');
  });

  test('the quick switcher jumps between documents', async ({ page }) => {
    await newDocument(page);
    await page.getByTestId('doc-title').fill('First doc');
    await page.getByTestId('new-document').click();
    await page.getByTestId('doc-title').fill('Second doc');
    await page.waitForTimeout(500);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.getByTestId('switcher-input').fill('first');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-title')).toHaveValue('First doc');
  });

  test('edits in another tab are picked up instead of overwritten', async ({ page, context }) => {
    await newDocument(page);
    await page.keyboard.type('Original text.', { delay: 5 });
    await expect(page.getByTestId('save-state')).toHaveText('Saved');

    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByTestId('editor')).toContainText('Original text.');
    await other.getByTestId('editor').click();
    await other.keyboard.press('End');
    await other.keyboard.type(' Added elsewhere.', { delay: 5 });
    await expect(other.getByTestId('save-state')).toHaveText('Saved');

    // The first tab has no unsaved changes, so it reloads the newer version.
    await expect(editor(page)).toContainText('Original text. Added elsewhere.');
    await other.close();
  });
});
