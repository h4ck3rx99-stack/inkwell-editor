import { test, expect, underline, card, newDocument } from './fixtures';

test.describe('mobile layout', () => {
  test('the suggestion card is a bottom sheet', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('I recieve mail every day.', { delay: 5 });
    await expect(underline(page, 'recieve')).toBeVisible({ timeout: 15_000 });
    await underline(page, 'recieve').tap();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveClass(/ink-card--sheet/);
    const box = await card(page).boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(viewport.height - 2);
    expect(Math.round(box!.width)).toBeGreaterThanOrEqual(viewport.width - 2);
    // Touch-friendly targets.
    const accept = await card(page).getByTestId('card-accept').boundingBox();
    expect(accept!.height).toBeGreaterThanOrEqual(40);
    await card(page).getByTestId('card-accept').tap();
    await expect(page.getByTestId('editor')).toContainText('I receive mail');
  });

  test('the sidebar is a drawer', async ({ page }) => {
    await newDocument(page);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).not.toHaveClass(/is-open/);
    await page.getByTestId('open-sidebar').tap();
    await expect(sidebar).toHaveClass(/is-open/);
    // Slides in fully (after its short transition).
    await expect.poll(async () => (await sidebar.boundingBox())!.x).toBeGreaterThanOrEqual(-1);
    await expect(page.locator('.ink-scrim')).toBeVisible();
    await page.locator('.ink-scrim').click({ position: { x: page.viewportSize()!.width - 10, y: 200 } });
    await expect(sidebar).not.toHaveClass(/is-open/);
  });

  test('no horizontal overflow at phone width', async ({ page }) => {
    await newDocument(page);
    await page.keyboard.type('A reasonably long line of text that should wrap cleanly on a small phone screen without overflow.', { delay: 2 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
