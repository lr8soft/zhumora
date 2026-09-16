import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import App from './App'
import './index.css'
import { MermaidRenderer } from './mermaidRenderer'
import { MermaidRendererProvider } from './mermaidContext'

const mermaidRenderer = new MermaidRenderer()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MermaidRendererProvider renderer={mermaidRenderer}>
      <App />
    </MermaidRendererProvider>
  </React.StrictMode>
)
