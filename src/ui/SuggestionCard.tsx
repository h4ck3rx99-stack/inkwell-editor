'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/lib/store';
import type { EditorSession } from '@/editor/session';
import { CATEGORY_LABEL, isAdvisory } from '@/suggestions/model';
import { placeNear } from './position';
import { MOBILE_QUERY, useMediaQuery } from './hooks';

function describeReplacement(r: string) {
  return r === '' ? 'remove' : r;
}

export function SuggestionCard({ session }: { session: EditorSession }) {
  const cardId = useStore(session.state, (s) => s.card?.id ?? null);
  // Keyed by suggestion so per-card state (e.g. "Why?" expanded) starts fresh.
  return cardId ? <CardView key={cardId} session={session} /> : null;
}

function CardView({ session }: { session: EditorSession }) {
  const card = useStore(session.state, (s) => s.card);
  const aiMode = useStore(session.state, (s) => s.aiMode);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const s = card ? session.getSuggestion(card.id) : undefined;

  useLayoutEffect(() => {
    if (!card || mobile) return;
    const place = () => {
      const anchor = session.editor.view.dom.querySelector(`[data-sid="${card.id}"]`);
      const el = ref.current;
      if (!anchor || !el) return;
      const rects = anchor.getClientRects();
      const rect = rects[0] ?? anchor.getBoundingClientRect();
      const p = placeNear(rect, { width: el.offsetWidth, height: el.offsetHeight });
      setPos({ top: p.top, left: p.left });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [card, mobile, session, whyOpen]);

  useEffect(() => {
    const onFocusCard = () => ref.current?.querySelector<HTMLElement>('button')?.focus();
    document.addEventListener('inkwell:focus-card', onFocusCard);
    return () => document.removeEventListener('inkwell:focus-card', onFocusCard);
  }, []);

  if (!card || !s) return null;

  const advisory = isAdvisory(s);
  const refocus = () => session.editor.view.focus();
  const accept = (i: number) => {
    session.accept(s.id, i);
    refocus();
  };
  const why = () => {
    const next = !whyOpen;
    setWhyOpen(next);
    if (next && card.why.status === 'idle') void session.explainSuggestion(s.id);
  };

  const body = (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${s.title}: suggestion`}
      className={`ink-card${mobile ? ' ink-card--sheet' : ''}`}
      data-testid="suggestion-card"
      data-severity={s.severity}
      data-mode={card.mode}
      style={mobile ? undefined : { top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onMouseEnter={() => session.cardPointer(true)}
      onMouseLeave={() => session.cardPointer(false)}
      onMouseDown={(e) => {
        // Keep the editor's selection; buttons still receive clicks.
        if ((e.target as HTMLElement).closest('button') === null) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          session.closeCard();
          refocus();
        }
      }}
    >
      <div className="ink-card__head">
        <span className="ink-card__category">{CATEGORY_LABEL[s.category]}</span>
        {s.title.toLowerCase() !== CATEGORY_LABEL[s.category].toLowerCase() && <span className="ink-card__title">{s.title}</span>}
        {s.source === 'ai' && <span className="ink-card__source" title="Found by the AI check">AI</span>}
      </div>

      {!advisory ? (
        <div className="ink-card__change">
          <del>{s.original}</del>
          <span className="ink-card__arrow" aria-hidden="true">→</span>
          <button type="button" className="ink-card__primary" onClick={() => accept(0)} data-testid="card-replacement-0">
            {s.replacements[0] === '' ? <em>remove</em> : s.replacements[0]}
          </button>
        </div>
      ) : (
        <p className="ink-card__advisory">{s.explanation}</p>
      )}

      {s.replacements.length > 1 && (
        <div className="ink-card__alts" role="group" aria-label="Other options">
          {s.replacements.slice(1).map((r, i) => (
            <button key={i} type="button" className="ink-chip" onClick={() => accept(i + 1)} data-testid={`card-replacement-${i + 1}`}>
              {card.mode === 'keyboard' && <kbd>{i + 2}</kbd>}
              {describeReplacement(r)}
            </button>
          ))}
        </div>
      )}

      {!advisory && s.explanation && <p className="ink-card__explain">{s.explanation}</p>}

      {whyOpen && (
        <div className="ink-card__why" aria-live="polite">
          {card.why.status === 'loading' && !card.why.text && <span className="ink-muted">Thinking it through…</span>}
          {card.why.text && <p>{card.why.text}</p>}
          {card.why.status === 'done' && !card.why.text && <p className="ink-muted">No further detail for this rule.</p>}
          {s.source === 'local' && <p className="ink-muted ink-card__rule">Rule: {s.ruleId}</p>}
        </div>
      )}

      <div className="ink-card__actions">
        {!advisory && (
          <button type="button" className="ink-btn ink-btn--primary" onClick={() => accept(0)} data-testid="card-accept">
            Accept{card.mode === 'keyboard' && <kbd>↵</kbd>}
          </button>
        )}
        {advisory && aiMode === 'ai' && (
          <button
            type="button"
            className="ink-btn ink-btn--primary"
            onClick={() => void session.rewrite(s.category === 'readability' ? 'clearer' : 'improve', { label: 'Rewrite', range: { from: s.from, to: s.to } })}
          >
            Rewrite with AI
          </button>
        )}
        <button type="button" className="ink-btn" onClick={() => { session.dismiss(s.id); refocus(); }} data-testid="card-dismiss">
          Dismiss
        </button>
        {s.category === 'spelling' && /^[\p{L}'’-]+$/u.test(s.original) && (
          <button type="button" className="ink-btn ink-btn--quiet" onClick={() => { session.addToDictionary(s.id); refocus(); }} data-testid="card-add-dictionary">
            Add to dictionary
          </button>
        )}
      </div>
      <div className="ink-card__links">
        {(s.explanation || s.source === 'ai') && (
          <button type="button" className="ink-link" aria-expanded={whyOpen} onClick={why}>
            Why?
          </button>
        )}
        <button type="button" className="ink-link" onClick={() => { session.ignoreRule(s.id); refocus(); }} title="Stop showing this kind of suggestion in this document">
          Ignore this rule here
        </button>
      </div>
      {card.mode === 'keyboard' && !mobile && (
        <p className="ink-card__hint" aria-hidden="true">
          {advisory ? 'Tab for actions · Esc to close' : `↵ accept${s.replacements.length > 1 ? ' · 1–3 choose' : ''} · Tab for more · Esc to close`}
        </p>
      )}
    </div>
  );

  return createPortal(
    mobile ? (
      <div className="ink-sheet-scrim" onClick={() => session.closeCard()}>
        <div onClick={(e) => e.stopPropagation()}>{body}</div>
      </div>
    ) : (
      body
    ),
    document.body,
  );
}
