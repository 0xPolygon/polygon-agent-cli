import { TrailsProvider } from '0xtrails/widget';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './index.css';
import { trailsApiKey } from './config.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrailsProvider config={{ trailsApiKey }}>
      <App />
    </TrailsProvider>
  </StrictMode>
);
