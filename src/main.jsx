import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/app.css';
import './styles/meta.css';
import './styles/ai.css';
import './styles/notes.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
