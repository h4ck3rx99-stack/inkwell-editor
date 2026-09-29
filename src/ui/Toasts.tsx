'use client';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import type { AppController, Toast } from './app-controller';

function ToastItem({ app, toast }: { app: AppController; toast: Toast }) {
  useEffect(() => {
    const t = setTimeout(() => app.dismissToast(toast.id), toast.timeoutMs);
    return () => clearTimeout(t);
  }, [app, toast]);
  return (
    <div className="ink-toast" data-testid="toast">
      <span>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="ink-toast__action"
          onClick={() => {
            toast.action!.run();
            app.dismissToast(toast.id);
          }}
          data-testid="toast-action"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function Toasts({ app }: { app: AppController }) {
  const toasts = useStore(app.state, (s) => s.toasts);
  return (
    <div className="ink-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} app={app} toast={t} />
      ))}
    </div>
  );
}
