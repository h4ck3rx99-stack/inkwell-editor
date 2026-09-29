'use client';
import dynamic from 'next/dynamic';

// The editor, IndexedDB and the analysis worker are browser-only.
const App = dynamic(() => import('./App'), { ssr: false, loading: () => <div className="ink-app ink-app--loading" aria-busy="true" /> });

export function ClientApp() {
  return <App />;
}
