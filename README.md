# Inkwell

A writing editor with a copy editor that reads along as you type.

Inkwell underlines the smallest span with a real problem — a typo, a wrong word, a tangled phrase — and stays quiet when your text is fine. Hover or click an underline (or press **F8**) to see the fix, accept it with a click or **Enter**, dismiss it, or just keep writing. Selecting text offers a few writing actions (improve, clearer, shorter, longer, tone, custom, explain) that preview inline and change nothing until you accept.

It works fully without AI: spelling, grammar and style checks run in your browser (harper.js compiled to WebAssembly plus Inkwell's own rules). With an AI provider configured, a second tier adds contextual corrections a dictionary can't catch.

Documents are stored locally in your browser (IndexedDB).

## Requirements

- Node.js 20.11+ (tested on Node 24)
- pnpm 11 (`corepack enable` will pick up the pinned version)

## Setup

```bash
pnpm install
```

`pnpm install` also copies harper's WebAssembly binary into `public/harper/` (it's gitignored and re-copied before every dev/build).

## Running locally

### Without an API key (local checks only)

```bash
pnpm dev
```

Open http://localhost:3000. Spelling, grammar and style checks work immediately; the status line reads "Local checks only" and AI actions explain calmly that AI isn't configured.

### With the deterministic mock model (no key, AI features on)

```bash
INKWELL_AI_PROVIDER=mock pnpm dev
```

The mock is labeled "Mock" in the UI. It catches a fixed set of issues (for example "their is", "could of", "alot", "irregardless") and returns deterministic rewrites. It's what the end-to-end tests use.

### With a real provider

Copy `.env.example` to `.env.local` and set a provider:

```bash
# Anthropic (default provider)
ANTHROPIC_API_KEY=sk-ant-...

# or OpenAI
INKWELL_AI_PROVIDER=openai
OPENAI_API_KEY=sk-...

# or any OpenAI-compatible endpoint (Ollama shown)
INKWELL_AI_PROVIDER=openai-compatible
INKWELL_AI_BASE_URL=http://localhost:11434/v1
INKWELL_AI_FAST_MODEL=llama3.2
```

Then `pnpm dev`, or for production:

```bash
pnpm build
pnpm start
```

## Environment variables

All are server-only and optional. See [.env.example](.env.example) for the full annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `INKWELL_AI_PROVIDER` | `anthropic` | `anthropic`, `openai`, `openai-compatible`, `mock`, or `none` |
| `INKWELL_AI_FAST_MODEL` | `claude-haiku-4-5-20251001` / `gpt-5-mini` | Model for real-time corrections |
| `INKWELL_AI_QUALITY_MODEL` | `claude-sonnet-5` / `gpt-5` | Model for writing actions |
| `INKWELL_AI_BASE_URL` | — | Base URL for openai-compatible providers (or a proxy) |
| `ANTHROPIC_API_KEY` | — | Anthropic key |
| `OPENAI_API_KEY` | — | OpenAI key (also used for openai-compatible if `INKWELL_AI_API_KEY` is unset) |
| `INKWELL_AI_API_KEY` | — | Key for an openai-compatible endpoint |
| `INKWELL_AI_TIMEOUT_MS` | `8000` | Real-time check timeout (including retries) |
| `INKWELL_AI_WRITE_TIMEOUT_MS` | `60000` | Writing-action timeout |
| `INKWELL_RATE_LIMIT_PER_MIN` | `120` | Per-client rate limit for checks (writing actions get 1/6) |
| `INKWELL_MOCK_LATENCY_MS` | `250` | Mock provider latency |
| `INKWELL_MOCK_MODE` | `ok` | Mock failure mode: `ok`, `error`, `timeout`, `malformed`, `ratelimit`, `flaky`, `noisy`, `empty` |
| `INKWELL_LOG` | — | `silent` suppresses the server's metadata-only AI logs |

Blank values are treated as unset.

## What leaves your device

Nothing, in local-only mode or when AI isn't configured. With AI on, real-time checks send only the paragraph being checked plus up to ~400 characters of the previous paragraph; writing actions send your selection and the sentences around it; "continue writing" sends the last ~1,500 characters; "summarize" sends the whole document only when you ask. The server never stores or logs document text. Settings has a global **Local-only mode** and a per-document **AI** toggle. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#privacy-boundary).

## Keyboard shortcuts

Mod is ⌘ on macOS and Ctrl elsewhere. Press **Mod+/** in the app for the full sheet.

| Keys | Action |
|---|---|
| F8 / Shift+F8 | Next / previous suggestion |
| Alt+Enter | Open the suggestion at or nearest the cursor (with a selection: writing actions) |
| Enter, 1–3 | Accept / choose an alternative (card opened from the keyboard) |
| Tab / Esc | Move into the card / close it |
| Mod+Shift+Enter | Continue writing (Tab accepts, Esc discards) |
| Mod+Enter / Esc | Accept / discard a rewrite preview |
| Mod+Z / Mod+Shift+Z | Undo / redo (an accepted suggestion is one step) |
| Mod+K | Quick switcher: documents and commands |
| Mod+\\ | Toggle the sidebar |
| Mod+Shift+L | Toggle the suggestions panel |
| Mod+Alt+F | Focus mode |
| Mod+Alt+N | New document |
| Mod+/ | Shortcuts |

Markdown-style shortcuts work as you type: `# ` headings, `- ` lists, `1. ` numbered lists, `> ` quotes, `**bold**`, `*italic*`, `` `code` ``.

## Tests and checks

```bash
pnpm lint            # ESLint (includes privacy-boundary rules)
pnpm typecheck       # tsc --noEmit, strict
pnpm test            # Vitest unit tests
pnpm build           # production build
pnpm check:bundle    # fails if any API key material is in the client bundle
pnpm test:e2e        # Playwright against the production build with the mock provider
pnpm verify          # all of the above in order
```

`pnpm test:e2e` needs a production build first and Playwright's Chromium (`pnpm exec playwright install chromium`). It starts `next start` on port 3217 with `INKWELL_AI_PROVIDER=mock`; set `E2E_PROD=0` to run against `next dev` instead. Every E2E test fails on any browser console error or unhandled rejection.

To prove keys never reach the browser, build with a canary and scan:

```bash
ANTHROPIC_API_KEY=sk-ant-canary-123456789 pnpm build
INKWELL_BUNDLE_CANARY=sk-ant-canary-123456789 pnpm check:bundle
```

## Project layout

```
app/                    Next.js App Router: layout, page, global styles, /api/ai/{check,write,status}
src/ui/                 React shell: sidebar, editor pane, card, selection menu, panels, dialogs
src/editor/             TipTap setup, EditorSession, suggestion/preview/focus plugins, paste sanitizer
src/suggestions/        Suggestion model, anchoring/verification, merge/dedupe, dismissal keys
src/analysis/scheduler/ When blocks get analyzed: debounce, settle, priority queue, abort, cache
src/analysis/local/     Web Worker with harper.js + deterministic rules (no network)
src/analysis/ai-client/ The only client code that sends text off the device
src/server/ai/          Prompts, validation, span resolution, retries, rate limit, provider adapters
src/storage/            DocumentStore interface, IndexedDB implementation, autosave, tab sync
src/shared/             Zod contract shared by client and server
tests/                  Vitest unit tests
e2e/                    Playwright end-to-end tests
docs/ARCHITECTURE.md    Design, pipeline, invariants, privacy boundary, decisions
```
