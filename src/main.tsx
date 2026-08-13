import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import App from './App';
import { useAuth } from './core/store';

function Bootstrap() {
  const ready = useAuth((s) => s.ready);
  const init = useAuth((s) => s.init);
  useEffect(() => { init(); }, [init]);
  if (!ready) return null;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
