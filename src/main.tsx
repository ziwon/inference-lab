import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import { CrashBoundary } from './ui/CrashBoundary.tsx';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashBoundary>
      <App />
    </CrashBoundary>
  </StrictMode>,
);
