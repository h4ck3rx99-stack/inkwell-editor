import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InkwellDB, IndexedDBDocumentStore, IndexedDBSettingsStore } from '@/storage/indexeddb';
import { Autosaver, type SaveState } from '@/storage/autosave';
import { DEFAULT_SETTINGS } from '@/settings/model';

let n = 0;
function stores() {
  const db = new InkwellDB(`test-${n++}`);
  return { db, docs: new IndexedDBDocumentStore(db), settings: new IndexedDBSettingsStore(db) };
}

describe('IndexedDB document store', () => {
  it('creates, lists and reads documents', async () => {
    const { docs } = stores();
    const a = await docs.create({ title: 'Alpha' });
    await docs.create({ title: 'Beta' });
    expect((await docs.list()).map((d) => d.title).sort()).toEqual(['Alpha', 'Beta']);
    expect((await docs.get(a.id))!.title).toBe('Alpha');
  });

  it('saves content with optimistic versioning and detects conflicting writers', async () => {
    const { docs } = stores();
    const d = await docs.create();
    const r1 = await docs.saveContent(d.id, { content: { type: 'doc' }, text: 'one', wordCount: 1 }, d.version);
    expect(r1).toMatchObject({ ok: true, version: 2 });
    // A second tab still believes the version is 1.
    const r2 = await docs.saveContent(d.id, { content: { type: 'doc' }, text: 'stale', wordCount: 1 }, 1);
    expect(r2.ok).toBe(false);
    expect((await docs.get(d.id))!.text).toBe('one');
  });

  it('soft-deletes, restores and purges', async () => {
    const { docs } = stores();
    const d = await docs.create({ title: 'Gone' });
    await docs.softDelete(d.id);
    expect(await docs.list()).toHaveLength(0);
    await docs.restore(d.id);
    expect(await docs.list()).toHaveLength(1);
    await docs.softDelete(d.id);
    expect(await docs.purgeDeleted(0)).toBe(1);
    expect(await docs.get(d.id)).toBeUndefined();
  });

  it('searches titles and content, titles first, with snippets', async () => {
    const { docs } = stores();
    const a = await docs.create({ title: 'Garden notes', text: 'Tomatoes and basil.' });
    const b = await docs.create({ title: 'Recipes', text: 'A long intro. Then the garden salad with tomatoes appears here.' });
    await docs.create({ title: 'Unrelated', text: 'Nothing here.' });
    const r = await docs.search('garden');
    expect(r.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(r[1]!.snippet.toLowerCase()).toContain('garden salad');
    expect(await docs.search('zzzz')).toEqual([]);
    expect(await docs.search('garden tomatoes')).toHaveLength(2);
  });

  it('persists view state without bumping the content version', async () => {
    const { docs } = stores();
    const d = await docs.create();
    await docs.updateMeta(d.id, { selection: { anchor: 5, head: 9 }, scrollTop: 120 });
    const after = (await docs.get(d.id))!;
    expect(after.selection).toEqual({ anchor: 5, head: 9 });
    expect(after.scrollTop).toBe(120);
    expect(after.version).toBe(d.version);
  });
});

describe('settings store', () => {
  it('round-trips settings and repairs invalid values', async () => {
    const { settings, db } = stores();
    expect(await settings.getSettings()).toEqual(DEFAULT_SETTINGS);
    await settings.setSettings({ ...DEFAULT_SETTINGS, dialect: 'en-GB' });
    expect((await settings.getSettings()).dialect).toBe('en-GB');
    await db.kv.put({ key: 'settings', value: { dialect: 'klingon', sensitivity: 'thorough' } });
    expect(await settings.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizes and dedupes dictionary words', async () => {
    const { settings } = stores();
    await settings.setDictionary(['Zorblat', 'zorblat', ' Quxx ', 'don’t']);
    expect(await settings.getDictionary()).toEqual(["don't", 'quxx', 'zorblat']);
  });
});

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces saves (~600ms) and reports state', async () => {
    const states: SaveState[] = [];
    const save = vi.fn(async () => 'ok' as const);
    const a = new Autosaver({ save, onState: (s) => states.push(s) });
    a.markDirty();
    await vi.advanceTimersByTimeAsync(300);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['unsaved', 'saving', 'saved']);
  });

  it('flushes immediately (blur / visibilitychange / unload)', async () => {
    const save = vi.fn(async () => 'ok' as const);
    const a = new Autosaver({ save, onState: () => {} });
    a.markDirty();
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff and warns after repeated failures', async () => {
    const states: SaveState[] = [];
    let fail = 3;
    const save = vi.fn(async () => {
      if (fail-- > 0) throw new Error('disk full');
      return 'ok' as const;
    });
    const a = new Autosaver({ save, onState: (s) => states.push(s), warnAfter: 3 });
    a.markDirty();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(save).toHaveBeenCalledTimes(4);
    expect(states).toContain('error');
    expect(states[states.length - 1]).toBe('saved');
  });

  it('pauses on a conflict instead of overwriting', async () => {
    const save = vi.fn(async () => 'conflict' as const);
    const states: SaveState[] = [];
    const a = new Autosaver({ save, onState: (s) => states.push(s) });
    a.markDirty();
    await vi.advanceTimersByTimeAsync(700);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toBe('conflict');
  });
});
