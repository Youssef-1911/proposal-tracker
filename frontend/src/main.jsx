import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { DemoStoreProvider } from './demo/DemoStore.jsx'
import { ApiProvider } from './api/ApiProvider.jsx'
import { API_MODE } from './data/source.js'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/dashboard.css'
import './styles/polish.css'

// API mode: requests, the tracker and the form use the backend. The demo store stays mounted
// only for the dashboards, which keep demo figures until the next phase.
const app = (
  <DemoStoreProvider>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </DemoStoreProvider>
)

createRoot(document.getElementById('root')).render(
  <StrictMode>{API_MODE ? <ApiProvider>{app}</ApiProvider> : app}</StrictMode>,
)
