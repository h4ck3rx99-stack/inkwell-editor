/**
 * IndexedDB (Dexie) implementation of the storage interfaces.
 * Local only: this module never makes network requests.
 */
import Dexie, { type Table } from 'dexie';
import { makeId } from '@/lib/hash';
import { DEFAULT_DOC_SETTINGS, DocSettingsSchema, normalizeDictionaryWord, parseSettings, type Settings } from '@/settings/model';
import type {
  ContentPatch, DocumentRecord, DocumentStore, DocumentSummary, MetaPatch, SaveResult, SearchResult, SettingsStore,
} from './types';

interface KV {
  key: string;
  value: unknown;
}

export class InkwellDB extends Dexie {
  documents!: Table<DocumentRecord, string>;
  kv!: Table<KV, string>;

  constructor(name = 'inkwell') {
    super(name);
    this.version(1).stores({
      documents: 'id, updatedAt, openedAt, deletedAt',
      kv: 'key',
    });
  }
}

export const EMPTY_DOC_CONTENT = { type: 'doc', content: [{ type: 'paragraph' }] };

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function summarize(d: DocumentRecord): DocumentSummary {
  return {
    id: d.id, title: d.title, wordCount: d.wordCount, createdAt: d.createdAt, updatedAt: d.updatedAt,
    openedAt: d.openedAt, deletedAt: d.deletedAt, preview: preview(d.text),
  };
}

function normalizeRecord(d: DocumentRecord): DocumentRecord {
  const settings = DocSettingsSchema.safeParse(d.settings);
  return {
    ...d,
    settings: settings.success ? settings.data : DEFAULT_DOC_SETTINGS,
    dismissed: Array.isArray(d.dismissed) ? d.dismissed : [],
    ignoredRules: Array.isArray(d.ignoredRules) ? d.ignoredRules : [],
    version: typeof d.version === 'number' ? d.version : 0,
  };
}

export class IndexedDBDocumentStore implements DocumentStore {
  constructor(private readonly db: InkwellDB) {}

  async list(): Promise<DocumentSummary[]> {
    const all = await this.db.documents.orderBy('updatedAt').reverse().toArray();
    return all.filter((d) => d.deletedAt === null).map(summarize);
  }

  async get(id: string) {
    const d = await this.db.documents.get(id);
    return d ? normalizeRecord(d) : undefined;
  }

  async create(init: Partial<Pick<DocumentRecord, 'title' | 'content' | 'text' | 'wordCount' | 'settings'>> = {}) {
    const now = Date.now();
    const doc: DocumentRecord = {
      id: makeId('d'),
      title: init.title ?? '',
      content: init.content ?? EMPTY_DOC_CONTENT,
      text: init.text ?? '',
      wordCount: init.wordCount ?? 0,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      deletedAt: null,
      version: 1,
      selection: null,
      scrollTop: 0,
      settings: init.settings ?? DEFAULT_DOC_SETTINGS,
      dismissed: [],
      ignoredRules: [],
    };
    await this.db.documents.add(doc);
    return doc;
  }

  async saveContent(id: string, patch: ContentPatch, expectedVersion: number): Promise<SaveResult> {
    return this.db.transaction('rw', this.db.documents, async () => {
      const current = await this.db.documents.get(id);
      if (!current) throw new Error('document not found');
      if (current.version !== expectedVersion) return { ok: false as const, conflict: normalizeRecord(current) };
      const version = current.version + 1;
      const updatedAt = Date.now();
      await this.db.documents.update(id, { content: patch.content, text: patch.text, wordCount: patch.wordCount, version, updatedAt });
      return { ok: true as const, version, updatedAt };
    });
  }

  async updateMeta(id: string, patch: MetaPatch) {
    const touchesContent = patch.title !== undefined;
    await this.db.documents.update(id, touchesContent ? { ...patch, updatedAt: Date.now() } : patch);
  }

  async softDelete(id: string) {
    await this.db.documents.update(id, { deletedAt: Date.now() });
  }

  async restore(id: string) {
    await this.db.documents.update(id, { deletedAt: null });
  }

  async purge(id: string) {
    await this.db.documents.delete(id);
  }

  async purgeDeleted(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    const stale = await this.db.documents.filter((d) => d.deletedAt !== null && d.deletedAt <= cutoff).primaryKeys();
    await this.db.documents.bulkDelete(stale);
    return stale.length;
  }

  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase();
    const docs = (await this.db.documents.toArray()).filter((d) => d.deletedAt === null);
    if (!q) return docs.sort((a, b) => b.updatedAt - a.updatedAt).map((d) => ({ ...summarize(d), snippet: '', matchedTitle: false }));
    const terms = q.split(/\s+/).filter(Boolean);
    const results: (SearchResult & { score: number })[] = [];
    for (const d of docs) {
      const title = (d.title || 'Untitled').toLowerCase();
      const text = d.text.toLowerCase();
      if (!terms.every((t) => title.includes(t) || text.includes(t))) continue;
      const matchedTitle = terms.some((t) => title.includes(t));
      const idx = text.indexOf(terms[0]!);
      const snippet = idx === -1 ? '' : (idx > 40 ? '…' : '') + d.text.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ').trim() + (idx + 80 < d.text.length ? '…' : '');
      results.push({ ...summarize(d), snippet, matchedTitle, score: (matchedTitle ? 1000 : 0) + d.updatedAt / 1e13 });
    }
    return results.sort((a, b) => b.score - a.score).map(({ score: _score, ...r }) => r);
  }
}

export class IndexedDBSettingsStore implements SettingsStore {
  constructor(private readonly db: InkwellDB) {}

  async getSettings(): Promise<Settings> {
    return parseSettings((await this.db.kv.get('settings'))?.value);
  }

  async setSettings(settings: Settings) {
    await this.db.kv.put({ key: 'settings', value: settings });
  }

  async getDictionary(): Promise<string[]> {
    const v = (await this.db.kv.get('dictionary'))?.value;
    return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : [];
  }

  async setDictionary(words: string[]) {
    const unique = [...new Set(words.map(normalizeDictionaryWord).filter(Boolean))].sort();
    await this.db.kv.put({ key: 'dictionary', value: unique });
  }

  async getLastDocumentId() {
    const v = (await this.db.kv.get('lastDocId'))?.value;
    return typeof v === 'string' ? v : null;
  }

  async setLastDocumentId(id: string | null) {
    await this.db.kv.put({ key: 'lastDocId', value: id });
  }
}

let singleton: { db: InkwellDB; docs: IndexedDBDocumentStore; settings: IndexedDBSettingsStore } | null = null;

export function getStores() {
  if (!singleton) {
    const db = new InkwellDB();
    singleton = { db, docs: new IndexedDBDocumentStore(db), settings: new IndexedDBSettingsStore(db) };
  }
  return singleton;
}
