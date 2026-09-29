'use client';
import type { AppController } from './app-controller';
import { useModKey } from './hooks';

/** First run (no documents yet). */
export function Welcome({ app }: { app: AppController }) {
  const mod = useModKey();
  return (
    <div className="ink-scroll">
      <div className="ink-page ink-welcome" data-testid="welcome">
        <p className="ink-welcome__mark">Inkwell</p>
        <h1 className="ink-welcome__title">A quiet page that reads along.</h1>
        <p className="ink-welcome__lede">
          Write as you normally would. Inkwell underlines only what needs attention: a typo, a tangled phrase, a word that’s spelled right but used wrong. Accept a fix with a click or a keystroke and keep going.
        </p>
        <div className="ink-welcome__actions">
          <button type="button" className="ink-btn ink-btn--primary ink-btn--lg" onClick={() => void app.createDocument()} data-testid="welcome-new">
            Start writing
          </button>
          <button type="button" className="ink-btn ink-btn--lg" onClick={() => void app.createDocument({ sample: true })} data-testid="welcome-sample">
            Open the welcome note
          </button>
        </div>
        <p className="ink-welcome__foot">
          Your documents stay in this browser. Press <kbd>{mod}</kbd> <kbd>/</kbd> any time for shortcuts.
        </p>
      </div>
    </div>
  );
}
