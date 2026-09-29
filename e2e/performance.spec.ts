import { test, expect, newDocument, editorText, verifySuggestions } from './fixtures';

type Hooks = { blockIndex(id: string): number; blockCount(): number };
type Log = { event: string; data: Record<string, unknown> }[];

test.describe('long documents', () => {
  test.setTimeout(90_000);

  test('10,000+ words: typing stays fluid and blocks near the cursor are analyzed first', async ({ page }) => {
    await newDocument(page);
    const paragraph = (i: number) =>
      `Paragraph ${i} explores an idea at some length so the document grows large. It has several sentences, and some of them teh model might flag. The writing continues with steady, ordinary prose about gardens, rivers, and small towns in the hills.`;
    const paragraphs = Array.from({ length: 260 }, (_, i) => paragraph(i));
    const words = paragraphs.join(' ').split(/\s+/).length;
    expect(words).toBeGreaterThan(10_000);

    // Paste it (exercises paste sanitization too).
    await page.evaluate((paras) => {
      const dt = new DataTransfer();
      dt.setData('text/html', paras.map((p) => `<p style="color:red" class="x">${p}</p>`).join(''));
      dt.setData('text/plain', paras.join('\n\n'));
      document.querySelector('[data-testid=editor]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, paragraphs);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __inkwell: Hooks }).__inkwell.blockCount()), { timeout: 15_000 }).toBeGreaterThanOrEqual(260);
    await expect(page.getByTestId('status-line')).toContainText(/10,\d{3} words|1\d,\d{3} words/, { timeout: 10_000 });

    // Clear the log, then type at the end of the document (the cursor is there after paste).
    await page.evaluate(() => {
      const log = (window as unknown as { __inkwellLog?: Log }).__inkwellLog;
      if (log) log.length = 0;
    });

    // Measure keydown → next painted frame for each keystroke.
    await page.evaluate(() => {
      const w = window as unknown as { __lat: number[] };
      w.__lat = [];
      document.addEventListener(
        'keydown',
        () => {
          const t0 = performance.now();
          requestAnimationFrame(() => setTimeout(() => w.__lat.push(performance.now() - t0), 0));
        },
        true,
      );
    });
    const typed = ' And now a final sentence typed at the very end of a long document.';
    await page.keyboard.type(typed, { delay: 25 });
    const latencies = await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat.sort((a, b) => a - b));
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    const median = latencies[Math.floor(latencies.length / 2)]!;
    console.log(`keystroke→frame latency on ${words} words: median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(60);

    expect((await editorText(page)).endsWith(paragraph(259) + typed)).toBe(true);

    // The first AI request after typing targets the cursor paragraph (the last one), not the top of the document.
    await expect
      .poll(() => page.evaluate(() => ((window as unknown as { __inkwellLog?: Log }).__inkwellLog ?? []).filter((e) => e.event === 'ai.request').length), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const firstIndex = await page.evaluate(() => {
      const log = (window as unknown as { __inkwellLog: Log }).__inkwellLog;
      const first = log.find((e) => e.event === 'ai.request')!;
      return (window as unknown as { __inkwell: Hooks }).__inkwell.blockIndex(first.data.blockId as string);
    });
    expect(firstIndex).toBeGreaterThanOrEqual(250);
    await verifySuggestions(page);
  });
});
