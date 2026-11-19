import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { httpApi } from './api.ts';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={httpApi()} />
  </StrictMode>,
);
