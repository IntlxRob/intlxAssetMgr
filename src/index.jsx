// src/index.jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';

// Find the root HTML element in your index.html
const container = document.getElementById('root');
const root = ReactDOM.createRoot(container);

// Simple render - let App handle ZAF client initialization
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);