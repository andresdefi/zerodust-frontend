import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/schibsted-grotesk/latin-400.css';
import '@fontsource/schibsted-grotesk/latin-500.css';
import '@fontsource/schibsted-grotesk/latin-600.css';
import '@fontsource/schibsted-grotesk/latin-700.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/redesign.css';
import { App } from './App';
import { applyTheme, storedTheme } from './lib/theme';

applyTheme(storedTheme(), false);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
