import { test as base, expect, type Page } from '@playwright/test';

export interface MockControl {
  latencyMs?: number;
  mode?: 'ok' | 'error' | 'timeout' | 'malformed' | 'ratelimit' | 'flaky' | 'noisy' | 'empty';
}

interface Fixtures {
  /** Console messages matching these patterns are expected in this test (e.g. deliberate 5xx responses). */
  allowConsole: RegExp[];
  mock: MockControl;
  consoleGuard: void;
}

/**
 * Every test fails on a browser console error or an unhandled rejection
 * unless it explicitly allows a specific message.
 */
export const test = base.extend<Fixtures>({
  allowConsole: [[], { option: true }],
  mock: [{ latencyMs: 120, mode: 'ok' }, { option: true }],
  consoleGuard: [
    async ({ page, allowConsole, mock }, use) => {
      const problems: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error' && !(msg.type() === 'warning' && /ProseMirror|React|hydrat/i.test(msg.text()))) return;
        if (allowConsole.some((re) => re.test(msg.text()))) return;
        problems.push(`console.${msg.type()}: ${msg.text()}`);
      });
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
      await page.addInitScript((m) => {
        try {
          localStorage.setItem('inkwell.mock', JSON.stringify(m));
        } catch {
          // storage unavailable
        }
        window.addEventListener('unhandledrejection', (e) => console.error(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));
      }, mock);
      await use();
      expect(problems, 'browser console must stay clean').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const editor = (page: Page) => page.getByTestId('editor');
export const underline = (page: Page, text: string) => page.locator('.ink-sug', { hasText: text });
export const card = (page: Page) => page.getByTestId('suggestion-card');

export async function newDocument(page: Page) {
  await page.goto('/');
  await page.getByTestId('welcome-new').click();
  await expect(editor(page)).toBeVisible();
  await editor(page).click();
}

export async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid=editor]')!;
    return [...el.children].map((c) => c.textContent).join('\n');
  });
}

export async function verifySuggestions(page: Page) {
  const result = await page.evaluate(() => (window as unknown as { __inkwell: { verifySuggestions(): { ok: boolean; problems: string[] } } }).__inkwell.verifySuggestions());
  expect(result.problems).toEqual([]);
}

export async function suggestionTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __inkwell: { suggestions(): { original: string }[] } }).__inkwell.suggestions().map((s) => s.original));
}

/** Wait until the harper engine has loaded (spelling underlines depend on it). */
export async function waitForSpelling(page: Page, word = 'recieve') {
  await expect(underline(page, word)).toBeVisible({ timeout: 15_000 });
}

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
