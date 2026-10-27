import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <h1>Inference Lab</h1>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
