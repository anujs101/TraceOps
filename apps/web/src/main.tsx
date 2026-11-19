import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { httpApi } from './api.ts';
import { App } from './App.tsx';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={httpApi()} />
  </StrictMode>,
);
