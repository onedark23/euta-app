import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Pretendard variable font from the npm package — bundled into out/renderer, works offline (SPEC 글꼴).
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@xterm/xterm/css/xterm.css';
import './ui/tokens.css';
import './ui/ui.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
