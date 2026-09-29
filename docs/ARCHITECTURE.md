# Inkwell architecture

Inkwell is a local-first writing editor with a correction layer that reads along as you type. This document describes how it is built, why, and where the important invariants live.

## Layers

Dependencies point one way. Each layer only knows about the ones below it.

```
 UI (React, src/ui)                          shell, sidebar, card, menus, panels, dialogs
   │  reads throttled stores; never re-renders on keystrokes
   ▼
 Editor (src/editor)                          TipTap/ProseMirror, EditorSession, plugins, keymap
   │
   ▼
 Suggestion engine (src/suggestions)          model, anchoring/verification, merge/dedupe, dismissal keys
   │
   ▼
 Analysis orchestration (src/analysis/scheduler)   dirty blocks, debounce, settle detection, priority queue,
   │                                               per-block abort, cache, circuit breaker
   ├──────────────► Local analyzers (src/analysis/local)      Web Worker: harper.js WASM + deterministic rules
   │
   └──────────────► AI client (src/analysis/ai-client)        the only client code that sends text
                        │  HTTPS, same origin
                        ▼
                    Server AI routes (app/api/ai/*) → src/server/ai
                        orchestration, prompts, Zod validation, span resolution,
                        retries, timeouts, rate limit, breaker
                        │
                        ▼
                    Provider adapters: anthropic | openai | openai-compatible | mock

 Persistence (src/storage)                    DocumentStore + SettingsStore on IndexedDB (Dexie),
                                              autosave, cross-tab BroadcastChannel
```

Shared, dependency-free code lives in `src/lib` (hashing, text utilities, circuit breaker, store), `src/settings` (settings model) and `src/shared/ai-contract.ts` (the Zod wire contract used on both sides of the client/server boundary).

ESLint enforces the boundaries: `src/analysis/local/**` and `src/storage/**` may not use `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource`, or import the AI client or server; editor/suggestions/scheduler/UI code may not call `fetch` at all (only `src/analysis/ai-client` does), and client code may not import `src/server`. Server modules import `server-only`.

## The editor

- **TipTap 3 (ProseMirror)** with StarterKit (headings, lists, blockquote, bold/italic, links, code, markdown input rules, undo/redo), a placeholder, and Inkwell's own extensions. TipTap's CSS injection is off; the ProseMirror essentials are in `app/globals.css`.
- **Editor state is not React state.** `EditorSession` (`src/editor/session.ts`) owns the editor and publishes a small store (word count, suggestion list, save state, card state…) through throttled updates. React components subscribe with `useSyncExternalStore`. Typing never re-renders React.
- **Block identity.** `BlockId` (`src/editor/extensions/block-id.ts`) gives every textblock (paragraphs and headings, including paragraphs inside list items and quotes) a `bid` attribute. Ids are assigned in `appendTransaction` only when a transaction could have created or duplicated a block (plain typing is skipped), are excluded from undo history, use `keepOnSplit: false`, and are never rendered to the DOM — so copy/paste always yields fresh ids and duplicates are repaired immediately. Analysis results, caches and in-flight requests are keyed per block. Because block ids are the analysis unit and textblocks are the natural unit of text, list items are identified by their paragraph rather than the `listItem` wrapper.
- **Paste sanitization** (`src/editor/paste.ts`) strips styles, classes, fonts, scripts, Office namespaces, images and unsafe links, unwraps the Google Docs `<b id="docs-internal-guid…">` wrapper, and turns styled bold/italic spans into real marks before ProseMirror parses the result against the schema.
- **Native spellcheck is off** (`spellcheck="false"`) so the browser's own underlines don't compete with Inkwell's.

## The suggestion model and its invariants

`src/suggestions/model.ts` defines one `Suggestion` type shared by the local and AI tiers (`source: 'local' | 'ai'`), with `from/to` live document positions, `original`, `replacements` (`[]` = advisory), `category`, `severity`, `ruleId`, `title`, `explanation`, `confidence`, `blockHash`, `revision` and `status`.

Suggestions live in a ProseMirror plugin (`src/editor/suggestions-plugin.ts`) and render only as inline **Decorations**. They never enter the document, the undo history, autosave or the clipboard (verified by unit tests).

Invariants and where they are enforced:

| Invariant | Where |
|---|---|
| Ranges are mapped through `tr.mapping` on every transaction | `mapSuggestionRange` in the plugin's `apply` |
| An edit that touches or overlaps a range makes it stale and removes it immediately | `mapSuggestionRange` returns `null` → removed; decoration removed in the same transaction |
| Nothing renders or applies unless `textBetween(from, to) === original`; otherwise relocate within the block only if `original` occurs exactly once, else drop | `anchorFindings` (render) and `verifySuggestion` (accept) in `src/suggestions/anchor.ts` |
| No two visible suggestions overlap; priority is error > improvement > style, then confidence, then the narrower span | `selectVisible` in `src/suggestions/merge.ts`, applied per block in the plugin |
| Local and AI findings on the same span with the same fix are deduplicated (local wins ties) | `isDuplicate` / `comparePriority` |
| A stale response never touches the document | block text hash check in `anchorFindings` plus the scheduler's own check |

"Touching" is deliberately inclusive: typing a letter right after a misspelling, or deleting the character just before it, invalidates it. The one exception is a pure insertion at a boundary whose adjacent character is not a word character — typing a space or comma after a flagged word keeps its underline, so the underline doesn't blink out and back in.

Overlap resolution keeps *all* candidates in plugin state and derives the visible set, so if the winner of an overlap is accepted or dismissed, a shadowed finding can appear. Dismiss removes twins on the same span from both tiers so a dismissed issue never reappears via the other tier.

Decorations are updated incrementally: only suggestions whose display state changed are removed or added. Newly shown underlines carry a fade-in class that is dropped ~220 ms later, so re-renders never replay the animation.

### Not flagging the word being typed

Two layers cooperate:

1. The local analyzer receives the cursor offset and withholds spelling findings that touch it, reporting `cursorSuppressed`; when the caret later leaves that word (or its block), the session re-runs local analysis for the block.
2. The plugin defers any suggestion created while the caret is inside its range until the caret leaves; typing a word boundary reveals it immediately.

Unmatched opening brackets/quotes are also withheld while the writer is still inside that sentence.

## The analysis pipeline

`src/analysis/scheduler/scheduler.ts` decides *when* each block is analyzed. It is a pure class driven by a host interface, so it is unit-tested with fake timers.

**Local tier** — always on, private, instant.
- Every edited block is marked dirty; a ~150 ms debounce (max wait 1 s during continuous typing) sends dirty blocks to the worker, cursor block first, then visible blocks, then the rest, in chunks.
- The worker (`src/analysis/local/worker.ts`) hosts **harper.js** (Rust grammar checker compiled to WASM; spelling and rule-based grammar, five English dialects, user dictionary) and Inkwell's deterministic rules (`rules.ts`): repeated words, a/an by sound, sentence-initial capitalization and lowercase "i", double spaces, missing space after punctuation, space before punctuation, unmatched brackets and quotes, filler words and wordy phrases, very long sentences (advisory), and repeated sentence starters. Shared skip logic excludes URLs, emails, @handles, file paths, inline code, all-caps acronyms, numbers and likely proper nouns, and honors the user dictionary.
- Worker messages are processed strictly in order, so a dictionary or dialect change always lands before the next analysis. If the WASM fails to load, rule-based checks still run.

**AI tier** — contextual, debounced, cancellable.
- A block becomes eligible once it has **settled**: a sentence was completed (terminal punctuation followed by a space, or Enter), the user paused ~900 ms, or the cursor moved to another block. Settling uses one shared timer so blocks that settle together are prioritized together.
- Eligible blocks enter a **priority queue**: the cursor block, then visible blocks ordered by distance from the cursor, then everything else. Off-screen blocks are *background* work that only starts after ~1.5 s of idle. A bulk edit (paste, large undo) only foregrounds the blocks near the writer. Concurrency is capped at **2** requests.
- **Caching:** results are cached by `hash(block text + dialect, sensitivity, goal, enabled categories)` (LRU, 500 entries). An unchanged block is never re-sent; if text reverts to an analyzed state, the cached result is reused.
- **Cancellation:** one `AbortController` per block. Any edit to a block aborts its in-flight request. The abort propagates to the server route (`request.signal`) and from there into the provider SDK/HTTP call.
- Long blocks (> ~1,200 chars) are split into sentence windows of up to ~800 chars, sent sequentially under the same controller; offsets are rebased onto the block.
- **Failures:** a client-side circuit breaker (3 failures → pause 15 s, doubling up to 2 min, one half-open probe) pauses AI checks; 429/503 with `Retry-After` pause for exactly that long; `navigator.onLine` is respected. Blocks that failed are retried when the breaker closes. Local checks are unaffected throughout. The only user-visible sign is the status line ("AI paused · local checks on").
- Results are applied only if the block's current text hash equals the request's hash. A monotonic `revision` (incremented on every doc change) is recorded with each request and logged with each decision; `window.__inkwellLog` holds the last 1,000 analysis events (never text) for tests and debugging.
- Nothing is analyzed or decorated during IME composition; results that arrive mid-composition are applied at `compositionend`.

## Model output: never trust positions

The model is asked for `original` (an exact substring), `prefix` (up to 30 preceding characters), replacements, category, severity, title, explanation and confidence — never offsets. The correction prompt is versioned in `src/server/ai/prompts/correction.ts` (`CORRECTION_PROMPT_VERSION`).

The server (`src/server/ai/service.ts`):

1. Validates the request with Zod (`src/shared/ai-contract.ts`); texts over 4,000 chars are rejected.
2. Calls the fast model with native structured output where available (Anthropic `output_config.format` JSON Schema; OpenAI `json_schema` strict mode), falling back to JSON mode and then prompt-only JSON when an endpoint rejects the format. Model-specific tuning lowers effort (and disables thinking where the model allows it) for latency.
3. Parses with robust extraction (raw JSON, fenced JSON, outermost `{…}`) and validates with Zod. A malformed envelope is logged (metadata only) and answered as "no findings"; individual invalid issues are dropped and counted.
4. Resolves spans (`resolve.ts`): exact match (prefix disambiguates duplicates; an empty prefix means "at the start"), then a whitespace/quote/dash-normalized match mapped back to source offsets. Anything unresolvable, ambiguous or straddling the previous block is dropped.
5. Filters (`validate.ts`): replacements identical to the original; advisory findings in mechanical categories; anything touching URLs, emails or code (including inline-code ranges sent by the client); spelling/grammar/punctuation fixes with a disproportionate edit (edit distance > 3 and ratio > 0.6, or very long spans); rewrites longer than one sentence; confidence below the sensitivity threshold; disabled categories; overlaps; and more than 4/8/12 issues per block (conservative/balanced/thorough).

The client validates the response with Zod again and re-verifies every span against the live document before rendering.

## Provider layer

`AIProvider` (`src/server/ai/providers/types.ts`) has two capabilities: `generateStructured` (corrections) and `streamText` (writing actions). Both honor an `AbortSignal` that carries the route's timeout and the client's disconnect.

- **anthropic** — official `@anthropic-ai/sdk` with `maxRetries: 0` (Inkwell owns retries). Default models: fast `claude-haiku-4-5-20251001`, quality `claude-sonnet-5`.
- **openai** — Chat Completions via `fetch` (json_schema structured output, SSE streaming).
- **openai-compatible** — the same adapter with a base URL (Ollama, LM Studio, OpenRouter, Groq), stepping down the structured-output ladder as needed.
- **mock** — deterministic model-like output with configurable latency and failure modes (`ok | error | timeout | malformed | ratelimit | flaky | noisy | empty`). Labeled "Mock" in the UI. When (and only when) the server runs the mock provider, a client may override latency/mode per request with the `x-inkwell-mock` header, set from `localStorage['inkwell.mock']`; the E2E suite uses this so parallel tests don't interfere.

Retries (`retry.ts`): exponential backoff with jitter on 429/5xx/network errors, honoring `Retry-After`, never sleeping past the route's deadline. Timeouts: 8 s for real-time checks, 60 s for writing actions (configurable). A server-side circuit breaker per provider (5 failures) fails fast with 503 + `Retry-After`. A per-client token bucket rate-limits the routes (120/min checks, 1/6 of that for writing actions).

Writing actions stream plain text. Errors before the first byte are JSON with an HTTP status; a failure after streaming began is signaled in-band with a marker the client recognizes. Retries happen only before the first chunk. Large documents are summarized in chunks (map), then summarized again (reduce).

## Suggestion lifecycle

```
analyzer finding (text offsets, block hash)
   │ filter: category on, confidence ≥ threshold, rule not ignored, not in dictionary,
   │         not dismissed, not an undo-restored fix
   ▼
anchorFindings ── block text hash differs? → dropped (stale)
   ▼
plugin setBlock (replaces that tier's findings for the block; same finding keeps its id)
   ▼
selectVisible (no overlaps) → deferred while under the caret → Decoration (fades in)
   │
   ├─ Accept  → verifySuggestion → one transaction, closeHistory + setTime(0) → exactly one undo step
   ├─ Dismiss → keys persisted per document; this span's twins removed
   ├─ Ignore  → nothing; stays until its text changes
   ├─ "Ignore this rule here" → ruleId stored per document
   ├─ Add to dictionary → global dictionary, worker reconfigured, matching spelling findings removed
   └─ any touching edit → stale → removed immediately
```

**Accept** uses `closeHistory(tr)` so it never merges with preceding typing, and `tr.setTime(0)` so the next keystroke starts a new undo group: Mod+Z undoes exactly the accept, Mod+Shift+Z redoes it. The cursor is mapped, never set.

**Dismiss** keys are `blockHash + original + rule` (as specified) plus a sentence-scoped key (`hash(sentence) + original + rule`) so a dismissal survives edits to *other* sentences of the same paragraph.

**Undo after accept**: when an undo restores text that a recent accept replaced, the `(block hash, original, replacement)` combination is suppressed for the session, so Inkwell doesn't immediately re-flag what the writer just reverted. Editing that paragraph again lifts the suppression.

## Race-condition strategy

1. **Hash-gated application.** Every result carries the hash of the exact text it analyzed. It is applied only if the block's current text still hashes the same; otherwise the whole response is discarded.
2. **Abort on edit.** Editing a block aborts its request (client → server → provider).
3. **Positions are derived, never trusted.** Model output has no offsets; the server resolves spans against the analyzed text; the client re-verifies them against the live document; accept re-verifies once more.
4. **Mapping + staleness.** Between analysis and interaction, ranges are mapped through every transaction and invalidated when touched.
5. **Programmatic changes preserve the selection.** Suggestion/preview/id transactions don't set the selection or enter history; accepts map it.
6. **Composition safety.** No analysis and no decoration changes while `view.composing`.
7. **Observability.** A monotonic revision is logged with requests, applications, aborts and stale drops.

The E2E suite types rapidly against a 1.5 s mock model and asserts the final text is exactly what was typed, the caret is where typing left it, and every rendered underline matches its text; it also edits a paragraph mid-request and asserts the request was aborted and its results never appear.

## Privacy boundary

**What leaves the device** (only when AI is configured, not in local-only mode, and enabled for the document):

| Feature | Text sent |
|---|---|
| Real-time checks | The paragraph being checked (or a ~800-char sentence window of a long one), up to ~400 characters of the preceding paragraph as read-only context, dialect, goal, sensitivity, enabled categories, and the offsets of inline-code ranges. Never the whole document. |
| Improve / clearer / shorter / longer / tone / custom / explain | The selection plus up to 600 characters before and after it. |
| Continue writing | The last ~1,500 characters before the cursor. |
| Summarize | The whole document — only when the user asks. |
| "Why?" on an AI suggestion | The suggestion and its paragraph (up to 2,000 chars). |

```
 Browser                                           Inkwell server                    Provider
 ┌──────────────────────────────────────┐          ┌──────────────────────────┐      ┌──────────┐
 │ Editor ──► local worker (harper+rules)│  never   │                          │      │          │
 │   │         no network                │  leaves  │                          │      │          │
 │   │                                   │          │                          │      │          │
 │   └──► ai-client ──── block/selection ─┼────────►│ /api/ai/* (validate,     │─────►│ Anthropic│
 │                                        │  HTTPS  │  resolve, filter; logs   │ HTTPS│ OpenAI   │
 │ IndexedDB (documents, settings)        │         │  metadata only)          │      │ …        │
 └──────────────────────────────────────┘          └──────────────────────────┘      └──────────┘
```

- `src/analysis/local/` and `src/storage/` make no network requests (lint-enforced). The worker's only fetch is harper's own GET of the same-origin static WASM binary (`/harper/…`), which carries no user text.
- `src/analysis/ai-client/` is the only client path that sends text; the `/api/ai/*` routes are the only server path that forwards it.
- The server never persists or logs document text: `logAI` has no field for it and logs only lengths, latency, status, provider, model, prompt version, drop reasons and error class (unit-tested).
- API keys exist only in server environment variables; nothing uses a `NEXT_PUBLIC_` prefix. `pnpm check:bundle` scans every file in `.next/static` for key prefixes, secret variable names and the actual secret values (and an optional canary injected at build time).
- Users control this in Settings: a global **Local-only mode**, a per-document **AI toggle**, and a plain-language "What gets sent" explanation. The status line always shows the mode ("Local checks only" or "AI checks · Anthropic").

## Persistence

- `DocumentStore` (`src/storage/types.ts`) is an interface; `IndexedDBDocumentStore` implements it with Dexie. A server-backed store could implement the same interface.
- Records hold ProseMirror JSON, plain text (search and previews), word count, timestamps, a content `version`, the last selection and scroll position, per-document settings, dismissal keys and ignored rules.
- **Autosave** (`autosave.ts`): debounced 600 ms after changes, plus on editor blur, `visibilitychange`, `pagehide`/`beforeunload` and when switching documents. Failures retry with backoff; after three consecutive failures the status line shows a warning while retries continue.
- **Cross-tab safety:** saves use optimistic versioning (`saveContent(…, expectedVersion)`). Other tabs are notified over `BroadcastChannel`. A tab with no unsaved changes reloads the newer version; a tab with unsaved changes pauses saving and shows a banner ("Load that version" / "Keep mine") instead of silently overwriting.
- Delete is a soft delete with an Undo toast; the record is purged a few seconds later (and any leftovers older than an hour at startup).
- Reopening restores the last document, cursor and scroll position.

## UI and design

- Ink on paper: warm paper background, near-black ink, a single fountain-pen blue accent, warm red for errors, muted dotted underlines for style. "Night ink" is a separately tuned dark palette, not an inversion. All colors are CSS variables in `app/globals.css`; theme is `system | light | dark`.
- Newsreader (optical sizes) for the page, Inter for UI, via `next/font`. The measure is ~36em (≈65–72 characters).
- Styling is one design-token stylesheet with BEM-like class names (chosen over Tailwind for a small, consistent, token-driven surface).
- The card is a popover (fixed position, flips above when needed) on desktop and a bottom sheet under 640 px; the sidebar becomes a drawer under 900 px. The viewport uses `interactive-widget=overlays-content` so the virtual keyboard doesn't reflow the page.
- Accessibility: native `<dialog>` for modals (focus trap, Esc), `role=menu` with arrow-key navigation for the selection menu, a combobox/listbox quick switcher, a keyboard-navigable issues panel that doubles as the screen-reader interface to suggestions, a throttled polite live region for counts and actions, visible focus rings and `prefers-reduced-motion` support.

## Keyboard shortcuts

Chosen to avoid standard editing and browser shortcuts. App-level shortcuts match on `event.code`, so keyboard layouts and Option-produced characters don't matter.

| Keys | Action |
|---|---|
| F8 / Shift+F8 | Next / previous suggestion (moves the caret, opens the card armed for the keyboard) |
| Alt+Enter | Open the card for the issue at or nearest the caret (without moving it); with a selection, open the writing-actions menu |
| Enter / 1–3 / Tab / Esc | In an armed card: accept / choose alternative / move into the card / close. Any other key closes the card and types normally. |
| Mod+Shift+Enter | Continue writing (Tab or Enter accepts, Esc or typing discards) |
| Mod+Enter / Esc | Accept / discard a rewrite preview |
| Mod+K (or Mod+P) | Quick switcher (documents and commands) |
| Mod+\\ | Toggle sidebar |
| Mod+Shift+L | Toggle suggestions panel |
| Mod+Alt+F | Focus mode (Esc exits) |
| Mod+Alt+N | New document |
| Mod+/ | Shortcuts sheet |

## Significant decisions

- **Stack versions.** Next.js 16.3 (App Router, Turbopack), React 19, TipTap 3.31, Dexie 4, Zod 4, Vitest 5, Playwright 1.63. TypeScript is pinned to **6.0** because typescript-eslint supports `<6.1`; ESLint is pinned to **9** because `eslint-plugin-react` (via `eslint-config-next`) crashes on ESLint 10.
- **harper.js as the local engine.** It integrated cleanly: ~0.6 s to initialize, 5–60 ms per paragraph, good precision on clean text, dialect support and a user dictionary. The slim WASM binary (~16 MB uncompressed) is copied to `public/harper/` by a `postinstall`/`prebuild` script and served with long-lived caching; it loads in the worker, not the main bundle. Our own rules cover what harper doesn't (filler, long sentences, repeated starters, brackets) and have skip logic tuned for a live editor; harper's overlapping `SentenceCapitalization`, `LongSentences` and `SpelledNumbers` rules are disabled. Spelling candidates are re-ranked (doubled letters and transpositions are cheap edits; word splits are expensive), and harper's spelling message is replaced with plainer wording.
- **Quality model default is `claude-sonnet-5`.** The brief suggested `claude-sonnet-5-5`, which is not a published model ID; `claude-sonnet-5` is the current Sonnet. Both model IDs are overridable.
- **Long-sentence advisories underline the whole sentence** with the faint dotted style; their action is "Rewrite with AI" when AI is available.
- **The AI tier analyzes the whole document lazily in the background** (idle-only, capped concurrency), per the brief. On a very long document with a paid provider this costs one request per paragraph once; results are cached for the session.
- **Undo-restored fixes are suppressed per session** rather than persisted, so they come back naturally in a later session or after further edits.
- **Debug hooks.** `window.__inkwell` (verification helpers) and `window.__inkwellLog` (analysis events, no text) are always present; they expose nothing that isn't already on screen.
- `next dev` generates `AGENTS.md`/`CLAUDE.md`; they are kept as generated.
