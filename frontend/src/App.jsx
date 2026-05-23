import { useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const [view, setView] = useState('chat');
  const [activeConvId, setActiveConvId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function handleSelectConv(id) { setActiveConvId(id); setView('chat'); }
  function handleNewChat() { setActiveConvId(null); setView('chat'); }
  function handleConvCreated(id) { setActiveConvId(id); setRefreshKey(k => k + 1); }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Sidebar
        activeConvId={activeConvId}
        activeView={view}
        refreshKey={refreshKey}
        onSelectConv={handleSelectConv}
        onNewChat={handleNewChat}
        onOpenDashboard={() => setView('dashboard')}
        onConvCancelled={() => setRefreshKey(k => k + 1)}
      />
      <main style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg)' }}>
        {view === 'chat' && (
          <ChatView
            key={activeConvId || 'new'}
            conversationId={activeConvId}
            onConvCreated={handleConvCreated}
          />
        )}
        {view === 'dashboard' && <Dashboard />}
      </main>
    </div>
  );
}
