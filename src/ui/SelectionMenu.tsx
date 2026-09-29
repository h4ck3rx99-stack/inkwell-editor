'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/lib/store';
import type { EditorSession } from '@/editor/session';
import { TONES, type Tone } from '@/shared/ai-contract';
import { placeNear } from './position';
import { IconChevron } from './Icons';

interface Props {
  session: EditorSession;
  onExplain: () => void;
  onOpenSettings: () => void;
}

const TONE_LABEL: Record<Tone, string> = { formal: 'Formal', friendly: 'Friendly', confident: 'Confident', neutral: 'Neutral', persuasive: 'Persuasive' };

export function SelectionMenu(props: Props) {
  const menu = useStore(props.session.state, (s) => s.selectionMenu);
  // Keyed by range so submenu state resets for each new selection.
  return menu ? <MenuView key={`${menu.from}:${menu.to}`} {...props} /> : null;
}

function MenuView({ session, onExplain, onOpenSettings }: Props) {
  const menu = useStore(session.state, (s) => s.selectionMenu);
  const aiMode = useStore(session.state, (s) => s.aiMode);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [sub, setSub] = useState<'tone' | 'custom' | null>(null);
  const [instruction, setInstruction] = useState('');

  useLayoutEffect(() => {
    if (!menu) return;
    const view = session.editor.view;
    const el = ref.current;
    if (!el) return;
    try {
      const a = view.coordsAtPos(menu.from);
      const b = view.coordsAtPos(menu.to);
      const rect = new DOMRect(Math.min(a.left, b.left), Math.min(a.top, b.top), Math.max(1, Math.abs(b.right - a.left)), Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top));
      const p = placeNear(rect, { width: el.offsetWidth, height: el.offsetHeight }, { prefer: 'above', gap: 10 });
      setPos({ top: p.top, left: Math.max(12, Math.min(p.left, window.innerWidth - el.offsetWidth - 12)) });
    } catch {
      setPos(null);
    }
  }, [menu, session, sub]);

  useEffect(() => {
    if (menu?.keyboard) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  if (!menu) return null;
  const ai = aiMode === 'ai';

  const run = (action: Parameters<EditorSession['rewrite']>[0], label: string, extra: { tone?: Tone; instruction?: string } = {}) => {
    void session.rewrite(action, { ...extra, label, range: { from: menu.from, to: menu.to } });
    session.editor.view.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (sub) setSub(null);
      else {
        session.closeSelectionMenu();
        session.editor.view.focus();
      }
    }
  };

  const item = (label: string, onClick: () => void, extra: Record<string, unknown> = {}) => (
    <button type="button" role="menuitem" className="ink-menu__item" onClick={onClick} {...extra}>
      {label}
    </button>
  );

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Writing actions"
      aria-orientation="horizontal"
      className="ink-menu"
      data-testid="selection-menu"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      {!ai ? (
        <div className="ink-menu__off">
          <span>{session.aiUnavailableMessage()}</span>
          {aiMode !== 'not-configured' && item('Settings', onOpenSettings)}
        </div>
      ) : sub === 'tone' ? (
        <>
          {TONES.map((t) => item(TONE_LABEL[t], () => run('tone', `Tone: ${TONE_LABEL[t].toLowerCase()}`, { tone: t }), { key: t }))}
          {item('Back', () => setSub(null))}
        </>
      ) : sub === 'custom' ? (
        <form
          className="ink-menu__custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (instruction.trim()) run('custom', 'Custom', { instruction: instruction.trim() });
          }}
        >
          <input
            autoFocus
            className="ink-input"
            aria-label="Instruction"
            placeholder="e.g. make it sound more like a letter"
            value={instruction}
            maxLength={300}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setSub(null);
              }
            }}
          />
          <button type="submit" className="ink-btn ink-btn--primary" disabled={!instruction.trim()}>
            Apply
          </button>
        </form>
      ) : (
        <>
          {item('Improve', () => run('improve', 'Improve'), { 'data-testid': 'action-improve' })}
          {item('Clearer', () => run('clearer', 'Make clearer'))}
          {item('Shorter', () => run('shorter', 'Shorter'), { 'data-testid': 'action-shorter' })}
          {item('Longer', () => run('longer', 'Longer'))}
          <button type="button" role="menuitem" aria-haspopup="menu" className="ink-menu__item" onClick={() => setSub('tone')}>
            Tone <IconChevron size={12} />
          </button>
          {item('Custom…', () => setSub('custom'))}
          <span className="ink-menu__sep" aria-hidden="true" />
          {item('Explain', onExplain)}
        </>
      )}
    </div>,
    document.body,
  );
}
