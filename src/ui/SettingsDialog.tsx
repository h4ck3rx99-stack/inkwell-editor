'use client';
import { useState, useSyncExternalStore } from 'react';
import { useStore } from '@/lib/store';
import {
  DIALECTS, DIALECT_LABEL, GOALS, GOAL_LABEL, SENSITIVITIES, THEMES, type Sensitivity, type Theme,
} from '@/settings/model';
import { CATEGORIES, CATEGORY_LABEL } from '@/suggestions/model';
import type { AppController } from './app-controller';
import { Dialog } from './Dialog';

const SENSITIVITY_NOTE: Record<Sensitivity, string> = {
  conservative: 'Only clear mistakes.',
  balanced: 'Mistakes plus the most useful improvements.',
  thorough: 'Everything worth a second look.',
};
const THEME_LABEL: Record<Theme, string> = { system: 'Match system', light: 'Paper', dark: 'Night ink' };

export function SettingsDialog({ app }: { app: AppController }) {
  const open = useStore(app.state, (s) => s.dialog === 'settings');
  return (
    <Dialog open={open} onClose={() => app.closeDialog()} title="Settings" className="ink-settings">
      {open && <SettingsBody app={app} />}
    </Dialog>
  );
}

function SettingsBody({ app }: { app: AppController }) {
  const settings = useStore(app.state, (s) => s.settings);
  const dictionary = useStore(app.state, (s) => s.dictionary);
  const aiStatus = useStore(app.state, (s) => s.aiStatus);
  const session = app.session;
  const docSettings = useSyncExternalStore(
    (cb) => session?.state.subscribe(cb) ?? (() => {}),
    () => session?.state.get().docSettings ?? null,
    () => null,
  );
  const [newWord, setNewWord] = useState('');

  return (
    <div className="ink-settings__body">
      <section className="ink-settings__section" aria-labelledby="set-writing">
        <h3 id="set-writing">Writing</h3>
        <label className="ink-field">
          <span>Dialect</span>
          <select className="ink-select" value={settings.dialect} onChange={(e) => void app.updateSettings({ dialect: e.target.value as (typeof DIALECTS)[number] })}>
            {DIALECTS.map((d) => (
              <option key={d} value={d}>{DIALECT_LABEL[d]}</option>
            ))}
          </select>
        </label>
        {docSettings && session && (
          <label className="ink-field">
            <span>Goal for this document</span>
            <select className="ink-select" value={docSettings.goal} onChange={(e) => session.updateDocSettings({ goal: e.target.value as (typeof GOALS)[number] })}>
              {GOALS.map((g) => (
                <option key={g} value={g}>{GOAL_LABEL[g]}</option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="ink-field ink-radios">
          <legend>Check sensitivity</legend>
          {SENSITIVITIES.map((s) => (
            <label key={s} className="ink-radio">
              <input type="radio" name="sensitivity" checked={settings.sensitivity === s} onChange={() => void app.updateSettings({ sensitivity: s })} />
              <span>
                <strong>{s[0]!.toUpperCase() + s.slice(1)}</strong> <span className="ink-muted">{SENSITIVITY_NOTE[s]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className="ink-settings__section" aria-labelledby="set-checks">
        <h3 id="set-checks">What to check</h3>
        <div className="ink-toggles">
          {CATEGORIES.map((c) => (
            <label key={c} className="ink-toggle">
              <input
                type="checkbox"
                checked={settings.categories[c]}
                onChange={(e) => void app.updateSettings({ categories: { ...settings.categories, [c]: e.target.checked } })}
              />
              <span>{CATEGORY_LABEL[c]}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="ink-settings__section" aria-labelledby="set-ai">
        <h3 id="set-ai">AI and privacy</h3>
        <p className="ink-muted ink-settings__status">
          {aiStatus?.configured
            ? `AI provider: ${aiStatus.label}${aiStatus.provider === 'mock' ? ' (deterministic test provider, not a real model)' : ''}.`
            : `AI is not configured on this server${aiStatus?.reason ? ` — ${aiStatus.reason}` : ''}. Local checks work fully without it.`}
        </p>
        <label className="ink-toggle ink-toggle--row">
          <input type="checkbox" checked={settings.localOnly} onChange={(e) => void app.updateSettings({ localOnly: e.target.checked })} data-testid="setting-local-only" />
          <span>
            <strong>Local-only mode</strong>
            <span className="ink-muted">Nothing you write leaves this device. Spelling, grammar and style checks still run.</span>
          </span>
        </label>
        {docSettings && session && (
          <label className="ink-toggle ink-toggle--row">
            <input type="checkbox" checked={docSettings.aiEnabled} disabled={settings.localOnly} onChange={(e) => session.updateDocSettings({ aiEnabled: e.target.checked })} data-testid="setting-doc-ai" />
            <span>
              <strong>AI for this document</strong>
              <span className="ink-muted">Turn off for anything sensitive; other documents are unaffected.</span>
            </span>
          </label>
        )}
        <details className="ink-privacy">
          <summary>What gets sent when AI is on</summary>
          <ul>
            <li><strong>Live checks:</strong> the paragraph you’re working on (long ones in sentence-sized pieces), up to about 400 characters of the paragraph before it for context, and your dialect and goal. Never the whole document.</li>
            <li><strong>Rewrite, shorten, tone, explain:</strong> only your selection and the sentences around it.</li>
            <li><strong>Continue writing:</strong> the last ~1,500 characters before the cursor.</li>
            <li><strong>Summarize:</strong> the whole document, only when you ask.</li>
          </ul>
          <p>Text goes to Inkwell’s server and from there to the configured provider. The server doesn’t store or log what you write — only sizes, timings and error types. Your documents are stored in this browser.</p>
        </details>
      </section>

      <section className="ink-settings__section" aria-labelledby="set-look">
        <h3 id="set-look">Appearance</h3>
        <fieldset className="ink-field ink-radios ink-radios--inline">
          <legend>Theme</legend>
          {THEMES.map((t) => (
            <label key={t} className="ink-radio">
              <input type="radio" name="theme" checked={settings.theme === t} onChange={() => void app.updateSettings({ theme: t })} />
              <span>{THEME_LABEL[t]}</span>
            </label>
          ))}
        </fieldset>
        <label className="ink-toggle ink-toggle--row">
          <input type="checkbox" checked={settings.typewriterScrolling} onChange={(e) => void app.updateSettings({ typewriterScrolling: e.target.checked })} />
          <span>
            <strong>Typewriter scrolling in focus mode</strong>
            <span className="ink-muted">Keeps the line you’re writing near the middle of the screen.</span>
          </span>
        </label>
      </section>

      <section className="ink-settings__section" aria-labelledby="set-dict">
        <h3 id="set-dict">Your dictionary</h3>
        <form
          className="ink-dict__add"
          onSubmit={(e) => {
            e.preventDefault();
            if (newWord.trim()) {
              void app.addToDictionary(newWord.trim());
              setNewWord('');
            }
          }}
        >
          <input className="ink-input" value={newWord} onChange={(e) => setNewWord(e.target.value)} placeholder="Add a word" aria-label="Add a word to your dictionary" maxLength={60} />
          <button type="submit" className="ink-btn" disabled={!newWord.trim()}>Add</button>
        </form>
        {dictionary.length === 0 ? (
          <p className="ink-muted">Words you add from a spelling suggestion appear here.</p>
        ) : (
          <ul className="ink-dict" data-testid="dictionary-list">
            {dictionary.map((w) => (
              <li key={w}>
                <span>{w}</span>
                <button type="button" className="ink-link" onClick={() => void app.removeFromDictionary(w)} aria-label={`Remove ${w}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
