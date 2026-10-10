import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { ToastProvider } from './components/Toast'
import Dashboard from './pages/Dashboard'
import Ledger from './pages/Ledger'
import Review from './pages/Review'
import SettingsPage from './pages/Settings'
import TicketCenter from './pages/TicketCenter'
import Agent from './pages/Agent'
import LocalAgent from './pages/LocalAgent'

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="agent" element={<LocalAgent />} />
          <Route path="agent-demo" element={<Agent />} />
          <Route path="tickets" element={<TicketCenter />} />
          <Route path="review" element={<Review />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}
