'use client';
import { useStore } from '@/lib/store';
import type { AppController } from './app-controller';
import { Dialog } from './Dialog';
import { useModKey } from './hooks';

export function ShortcutsSheet({ app }: { app: AppController }) {
  const open = useStore(app.state, (s) => s.dialog === 'shortcuts');
  const mod = useModKey();
  const alt = mod === '⌘' ? '⌥' : 'Alt';
  const groups: { title: string; rows: [string[], string][] }[] = [
    {
      title: 'Suggestions',
      rows: [
        [['F8'], 'Next suggestion'],
        [['Shift', 'F8'], 'Previous suggestion'],
        [[alt, 'Enter'], 'Open the suggestion at the cursor (or writing actions for a selection)'],
        [['Enter'], 'Accept (when a card is open from the keyboard)'],
        [['1', '2', '3'], 'Choose an alternative'],
        [['Tab'], 'Move into the card for Dismiss, Add to dictionary…'],
        [['Esc'], 'Close the card'],
        [[mod, 'Shift', 'L'], 'Suggestions panel'],
      ],
    },
    {
      title: 'Writing',
      rows: [
        [[mod, 'Shift', 'Enter'], 'Continue writing (AI)'],
        [['Tab'], 'Accept continuation'],
        [[mod, 'Enter'], 'Accept a rewrite preview'],
        [['Esc'], 'Discard a preview'],
        [[mod, 'Z'], 'Undo'],
        [[mod, 'Shift', 'Z'], 'Redo'],
        [[mod, 'B'], 'Bold'],
        [[mod, 'I'], 'Italic'],
        [['#', 'Space'], 'Heading (at line start; ## for smaller)'],
        [['-', 'Space'], 'Bulleted list'],
        [['>', 'Space'], 'Quote'],
      ],
    },
    {
      title: 'App',
      rows: [
        [[mod, 'K'], 'Jump to a document or command'],
        [[mod, '\\'], 'Show or hide the sidebar'],
        [[mod, alt, 'N'], 'New document'],
        [[mod, alt, 'F'], 'Focus mode'],
        [[mod, '/'], 'This list'],
      ],
    },
  ];
  return (
    <Dialog open={open} onClose={() => app.closeDialog()} title="Keyboard shortcuts" className="ink-shortcuts">
      <div className="ink-shortcuts__grid">
        {groups.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map(([keys, label]) => (
                <div key={label} className="ink-shortcut">
                  <dt>
                    {keys.map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
