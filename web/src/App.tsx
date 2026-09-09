import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from './config/wagmi'
import { useLottery } from './state/useLottery'
import Nav from './components/Nav'
import Live from './pages/Live'
import HowItWorks from './pages/HowItWorks'

const qc = new QueryClient()

function Shell() {
  const model = useLottery()
  return (
    <BrowserRouter>
      <Nav model={model} />
      <Routes>
        <Route path="/" element={<Live model={model} />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
      </Routes>
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <Shell />
      </QueryClientProvider>
    </WagmiProvider>
  )
}
