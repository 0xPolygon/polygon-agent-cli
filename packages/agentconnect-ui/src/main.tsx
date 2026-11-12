import { TrailsProvider } from '0xtrails/widget';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider } from '@polygonlabs/design-system';

import { App } from './App.tsx';
import { Toaster } from './components/Toaster.tsx';
import './index.css';
import { trailsApiKey } from './config.ts';

// Where the brand's values differ from the preset's: warning text, the secondary button's
// outline and the info badge's stroke.
const THEME_OVERRIDES = {
  light: { warning: '#d97706', borderButton: '#64708f', borderInfo: '#eae4f5' }
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light" storageKey={null} customThemes={THEME_OVERRIDES}>
      <Toaster>
        <TrailsProvider config={{ trailsApiKey }}>
          <App />
        </TrailsProvider>
      </Toaster>
    </ThemeProvider>
  </StrictMode>
);
