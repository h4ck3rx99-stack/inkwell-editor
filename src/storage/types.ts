import type { DocSettings, Settings } from '@/settings/model';

export interface SelectionState {
  anchor: number;
  head: number;
}

export interface DocumentRecord {
  id: string;
  title: string;
  /** ProseMirror JSON. */
  content: unknown;
  /** Plain text, for search and previews. */
  text: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  deletedAt: number | null;
  /** Incremented on every content save; used to detect edits from another tab. */
  version: number;
  selection: SelectionState | null;
  scrollTop: number;
  settings: DocSettings;
  /** Dismissal keys (see suggestions/keys.ts). */
  dismissed: string[];
  /** Rule ids ignored in this document. */
  ignoredRules: string[];
}

export type DocumentSummary = Pick<DocumentRecord, 'id' | 'title' | 'wordCount' | 'createdAt' | 'updatedAt' | 'openedAt' | 'deletedAt'> & {
  preview: string;
};

export interface SearchResult extends DocumentSummary {
  /** Snippet around the first content match (empty when only the title matched). */
  snippet: string;
  matchedTitle: boolean;
}

export type SaveResult = { ok: true; version: number; updatedAt: number } | { ok: false; conflict: DocumentRecord };

export interface ContentPatch {
  content: unknown;
  text: string;
  wordCount: number;
}

export type MetaPatch = Partial<Pick<DocumentRecord, 'title' | 'settings' | 'dismissed' | 'ignoredRules' | 'selection' | 'scrollTop' | 'openedAt'>>;

/**
 * Document persistence. Local-first today (IndexedDB); a server-backed
 * implementation can satisfy the same interface later.
 */
export interface DocumentStore {
  list(): Promise<DocumentSummary[]>;
  get(id: string): Promise<DocumentRecord | undefined>;
  create(init?: Partial<Pick<DocumentRecord, 'title' | 'content' | 'text' | 'wordCount' | 'settings'>>): Promise<DocumentRecord>;
  saveContent(id: string, patch: ContentPatch, expectedVersion: number): Promise<SaveResult>;
  updateMeta(id: string, patch: MetaPatch): Promise<void>;
  softDelete(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  purge(id: string): Promise<void>;
  purgeDeleted(olderThanMs: number): Promise<number>;
  search(query: string): Promise<SearchResult[]>;
}

export interface SettingsStore {
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<void>;
  getDictionary(): Promise<string[]>;
  setDictionary(words: string[]): Promise<void>;
  getLastDocumentId(): Promise<string | null>;
  setLastDocumentId(id: string | null): Promise<void>;
}
