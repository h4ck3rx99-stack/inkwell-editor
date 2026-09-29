import { test, expect, editor, underline, card, newDocument, editorText, verifySuggestions, waitForSpelling, mod } from './fixtures';

test.describe('core correction loop', () => {
  test('underlines appear in the right places', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('i recieve teh letter today. We could of gone earlier.', { delay: 5 });
    await waitForSpelling(page);
    await expect(underline(page, 'teh')).toBeVisible();
    await expect(underline(page, 'could of')).toBeVisible(); // AI (mock) finding
    await expect(page.locator('.ink-sug', { hasText: /^i$/ })).toBeVisible();
    // Exact spans: the underline covers precisely the problem text.
    await expect(underline(page, 'recieve')).toHaveText('recieve');
    await expect(underline(page, 'could of')).toHaveAttribute('data-source', 'ai');
    await verifySuggestions(page);
    await expect(page.getByTestId('issue-count')).toContainText('suggestions');
  });

  test('accept by click and by keyboard; dismiss sticks after re-analysis and reload', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('I recieve mail. The teh cat sleeps. A third sentence here.', { delay: 5 });
    await waitForSpelling(page);

    // Accept by click (hover card).
    await underline(page, 'recieve').hover();
    await expect(card(page)).toBeVisible();
    await card(page).getByTestId('card-accept').click();
    await expect.poll(() => editorText(page)).toContain('I receive mail.');
    await expect(underline(page, 'recieve')).toHaveCount(0);

    // Dismiss.
    await underline(page, 'teh').click();
    await expect(card(page)).toBeVisible();
    await card(page).getByTestId('card-dismiss').click();
    await expect(underline(page, 'teh')).toHaveCount(0);

    // Re-analysis (edit another sentence of the same paragraph) must not bring it back.
    await editor(page).press('End');
    await page.keyboard.type(' And more words now.', { delay: 5 });
    await page.waitForTimeout(1600);
    await expect(underline(page, 'teh')).toHaveCount(0);

    // Nor does a reload.
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    await page.reload();
    await expect(editor(page)).toContainText('The teh cat');
    await page.waitForTimeout(1500);
    await expect(underline(page, 'teh')).toHaveCount(0);
    await verifySuggestions(page);
  });

  test('accept from the keyboard with F8 and Enter', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('We recieve letters.', { delay: 5 });
    await waitForSpelling(page);
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press('F8');
    await expect(card(page)).toHaveAttribute('data-mode', 'keyboard');
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('We receive letters.');
  });

  test('add a word to the dictionary', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('The blorfnax is here.', { delay: 5 });
    await expect(underline(page, 'blorfnax')).toBeVisible({ timeout: 15_000 });
    await underline(page, 'blorfnax').click();
    await card(page).getByTestId('card-add-dictionary').click();
    await expect(underline(page, 'blorfnax')).toHaveCount(0);
    await editor(page).press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Another blorfnax appears. I recieve it.', { delay: 5 });
    await waitForSpelling(page);
    await expect(underline(page, 'blorfnax')).toHaveCount(0);
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('dictionary-list')).toContainText('blorfnax');
  });

  test('undo and redo after one and several accepts', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('I recieve teh mail.', { delay: 5 });
    await waitForSpelling(page);
    await expect(underline(page, 'teh')).toBeVisible();

    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press('F8');
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('I receive teh mail.');
    await page.keyboard.press('F8');
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('I receive the mail.');

    // Each accept is exactly one undo step.
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => editorText(page)).toBe('I receive teh mail.');
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => editorText(page)).toBe('I recieve teh mail.');
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect.poll(() => editorText(page)).toBe('I receive teh mail.');
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect.poll(() => editorText(page)).toBe('I receive the mail.');

    // Undoing an accept does not immediately re-flag the same issue.
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => editorText(page)).toBe('I receive teh mail.');
    await page.waitForTimeout(1500);
    await expect(underline(page, 'teh')).toHaveCount(0);
    await verifySuggestions(page);
  });

  test('several suggestions within one paragraph and across paragraphs', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('I recieve teh mail and alot of it.', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('Their is a dog. It could of barked.', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('Last line.', { delay: 5 });
    await waitForSpelling(page);
    for (const w of ['recieve', 'teh', 'alot', 'Their is', 'could of']) await expect(underline(page, w)).toBeVisible();
    const paragraphs = editor(page).locator('p');
    await expect(paragraphs.nth(0).locator('.ink-sug')).toHaveCount(3);
    await expect(paragraphs.nth(1).locator('.ink-sug')).toHaveCount(2);
    await verifySuggestions(page);
    // The issues panel lists them, grouped.
    await page.getByTestId('toggle-issues').click();
    await expect(page.getByTestId('issues-panel').locator('[data-issue]')).toHaveCount(5);
  });

  test('keyboard-only walkthrough of the whole loop', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('welcome')).toBeVisible();
    await page.keyboard.press(`${mod}+Alt+KeyN`); // new document
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type('We recieve teh post daily.', { delay: 5 });
    await waitForSpelling(page);

    // Jump to the first issue and accept it.
    await page.keyboard.press('F8');
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('We receive teh post daily.');

    // Next issue: move into the card with Tab and dismiss it.
    await page.keyboard.press('F8');
    await expect(card(page)).toContainText('teh');
    await page.keyboard.press('Tab'); // into the card
    const dismiss = card(page).getByTestId('card-dismiss');
    for (let i = 0; i < 8 && !(await dismiss.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(underline(page, 'teh')).toHaveCount(0);

    // Alt+Enter with nothing selected opens the nearest issue; Escape closes; typing continues normally.
    await editor(page).focus();
    await page.keyboard.press('End');
    await page.keyboard.type(' I recieve more.', { delay: 5 });
    await expect(underline(page, 'recieve')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Alt+Enter');
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await page.keyboard.type(' Done.', { delay: 5 });
    await expect.poll(() => editorText(page)).toBe('We receive teh post daily. I recieve more. Done.');

    // Shortcuts sheet and quick switcher are reachable from the keyboard.
    await page.keyboard.press(`${mod}+/`);
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByTestId('switcher-input')).toBeFocused();
    await page.keyboard.type('focus mode');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('app')).toHaveClass(/is-focus/);
  });

  test('typing into a card-armed editor closes the card and types normally', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('I recieve it', { delay: 5 });
    await page.keyboard.press('Enter');
    await waitForSpelling(page);
    await page.keyboard.press('F8');
    await expect(card(page)).toBeVisible();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('x', { delay: 5 });
    await expect(card(page)).toHaveCount(0);
    await expect.poll(() => editorText(page)).toBe('I recieve it\nx');
  });
});
