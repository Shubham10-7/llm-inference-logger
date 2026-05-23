import { useState, useEffect, useCallback } from 'react';
import { listConversations, cancelConversation } from '../lib/api.js';

const s = {
  sidebar: {
    width: 260,
    background: 'var(--bg2)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
  },
  header: {
    padding: '18px 16px 14px',
    borderBottom: '1px solid var(--border)',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  logoMark: {
    width: 28,
    height: 28,
    background: 'var(--accent)',
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: '#000',
    letterSpacing: '-0.5px',
    fontFamily: 'var(--mono)',
  },
  logoText: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text)',
    letterSpacing: '-0.3px',
  },
  newBtn: {
    width: '100%',
    background: 'var(--accent-dim)',
    border: '1px solid var(--accent-glow)',
    color: 'var(--accent)',
    borderRadius: 'var(--radius)',
    padding: '7px 12px',
    fontSize: 13,
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    transition: 'background .15s',
  },
  nav: {
    padding: '12px 8px 4px',
    borderBottom: '1px solid var(--border)',
  },
  navBtn: (active) => ({
    width: '100%',
    background: active ? 'var(--bg4)' : 'transparent',
    border: 'none',
    color: active ? 'var(--text)' : 'var(--text2)',
    borderRadius: 'var(--radius)',
    padding: '7px 10px',
    fontSize: 13,
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    textAlign: 'left',
    transition: 'all .15s',
    marginBottom: 2,
  }),
  convList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text3)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '6px 6px 4px',
  },
  convItem: (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 10px',
    borderRadius: 'var(--radius)',
    background: active ? 'var(--bg4)' : 'transparent',
    cursor: 'pointer',
    marginBottom: 1,
    transition: 'background .1s',
    minWidth: 0,
  }),
  convTitle: {
    flex: 1,
    fontSize: 13,
    color: 'var(--text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  convMeta: {
    fontSize: 11,
    color: 'var(--text3)',
    flexShrink: 0,
  },
  statusDot: (status) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
    background: status === 'active' ? 'var(--accent)' : status === 'cancelled' ? 'var(--red)' : 'var(--text3)',
  }),
  cancelBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text3)',
    fontSize: 12,
    padding: '1px 4px',
    borderRadius: 3,
    flexShrink: 0,
    opacity: 0,
    transition: 'opacity .15s',
  },
};

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

export default function Sidebar({ activeConvId, activeView, refreshKey, onSelectConv, onNewChat, onOpenDashboard, onConvCancelled }) {
  const [conversations, setConversations] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  const load = useCallback(async () => {
    try {
      const { conversations } = await listConversations();
      setConversations(conversations || []);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleCancel(e, id) {
    e.stopPropagation();
    setCancelling(id);
    try {
      await cancelConversation(id);
      await load();
      onConvCancelled?.();
    } catch {}
    setCancelling(null);
  }

  return (
    <div style={s.sidebar}>
      <div style={s.header}>
        <div style={s.logo}>
          <div style={s.logoMark}>{'{'}<span style={{color:'#000'}}>L</span>{'}'}</div>
          <span style={s.logoText}>LLM Logger</span>
        </div>
        <button style={s.newBtn} onClick={onNewChat}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(74,222,128,0.18)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--accent-dim)'}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New Chat
        </button>
      </div>

      <div style={s.nav}>
        <button style={s.navBtn(activeView === 'chat' && !activeConvId)} onClick={onNewChat}
          onMouseEnter={e => { if (activeView !== 'chat' || activeConvId) e.currentTarget.style.background = 'var(--bg3)'; }}
          onMouseLeave={e => { if (activeView !== 'chat' || activeConvId) e.currentTarget.style.background = 'transparent'; }}
        >
          <span>💬</span> Chat
        </button>
        <button style={s.navBtn(activeView === 'dashboard')} onClick={onOpenDashboard}
          onMouseEnter={e => { if (activeView !== 'dashboard') e.currentTarget.style.background = 'var(--bg3)'; }}
          onMouseLeave={e => { if (activeView !== 'dashboard') e.currentTarget.style.background = 'transparent'; }}
        >
          <span>📊</span> Dashboard
        </button>
      </div>

      <div style={s.convList}>
        <div style={s.sectionLabel}>Conversations</div>
        {conversations.length === 0 && (
          <div style={{ padding: '12px 8px', color: 'var(--text3)', fontSize: 12 }}>
            No conversations yet
          </div>
        )}
        {conversations.map(conv => (
          <div
            key={conv.id}
            style={s.convItem(conv.id === activeConvId)}
            onClick={() => onSelectConv(conv.id)}
            onMouseEnter={e => { setHoveredId(conv.id); if (conv.id !== activeConvId) e.currentTarget.style.background = 'var(--bg3)'; }}
            onMouseLeave={e => { setHoveredId(null); if (conv.id !== activeConvId) e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={s.statusDot(conv.status)} title={conv.status} />
            <span style={s.convTitle}>{conv.title || 'Untitled'}</span>
            <span style={s.convMeta}>{timeAgo(conv.updated_at)}</span>
            {conv.status === 'active' && (
              <button
                style={{ ...s.cancelBtn, opacity: hoveredId === conv.id ? 1 : 0 }}
                onClick={e => handleCancel(e, conv.id)}
                title="Cancel conversation"
              >
                {cancelling === conv.id ? '…' : '✕'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
