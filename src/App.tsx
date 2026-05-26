import Overview from './Overview'
import Outbound from './outbound/Outbound'

// Tiny client-side route switch. No react-router needed for two routes.
// /outbound and /outbound/{prospect_id} -> Outbound; everything else -> Overview.
function App() {
    const path = window.location.pathname
    if (path === '/outbound' || path.startsWith('/outbound/')) return <Outbound />
    return <Overview />
}

export default App
