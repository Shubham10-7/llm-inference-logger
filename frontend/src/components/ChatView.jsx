import { useState, useEffect, useRef, useCallback } from 'react';
import { getConversation, streamChat } from '../lib/api.js';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Message({ role, content, isStreaming }) {
  const isUser = role === 'user';
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 16,
      animation: 'fadeIn .25s ease',
    }}>
      {!isUser && (
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: 'var(--accent-dim)',
          border: '1px solid var(--accent-glow)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'var(--accent)', flexShrink: 0,
          marginRight: 10, marginTop: 2, fontFamily: 'var(--mono)', fontWeight: 700,
        }}>A</div>
      )}
      <div style={{
        maxWidth: '72%',
        background: isUser ? 'var(--accent-dim)' : 'var(--bg3)',
        border: `1px solid ${isUser ? 'var(--accent-glow)' : 'var(--border)'}`,
        borderRadius: isUser ? '12px 12px 2px 12px' : '2px 12px 12px 12px',
        padding: '10px 14px',
        color: 'var(--text)',
        fontSize: 14,
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {content}
        {isStreaming && (
          <span style={{
            display: 'inline-block',
            width: 2, height: 14, background: 'var(--accent)',
            marginLeft: 2, verticalAlign: 'middle',
            animation: 'blink 1s step-end infinite',
          }} />
        )}
      </div>
    </div>
  );
}

export default function ChatView({ conversationId, onConvCreated }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [convId, setConvId] = useState(conversationId);
  const [convStatus, setConvStatus] = useState('active');
  const [lastMeta, setLastMeta] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  // Load existing conversation
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setConvId(null);
      setConvStatus('active');
      return;
    }
    getConversation(conversationId).then(({ conversation, messages }) => {
      setConvId(conversation.id);
      setConvStatus(conversation.status);
      setMessages(messages || []);
    }).catch(() => {});
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (convStatus === 'cancelled') return;
    setError(null);
    setInput('');
    setStreaming(true);
    setStreamText('');

    const userMsg = { role: 'user', content: text, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = '';

    await streamChat({
      message: text,
      conversationId: convId,
      signal: controller.signal,
      onChunk: (chunk) => {
        accumulated += chunk;
        setStreamText(accumulated);
      },
      onDone: (meta) => {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: accumulated,
          created_at: new Date().toISOString(),
        }]);
        setStreamText('');
        setStreaming(false);
        setLastMeta(meta);
        if (!convId && meta.conversation_id) {
          setConvId(meta.conversation_id);
          onConvCreated?.(meta.conversation_id);
        }
      },
      onError: (err) => {
        setError(err || 'Stream error');
        setStreamText('');
        setStreaming(false);
        if (accumulated) {
          setMessages(prev => [...prev, { role: 'assistant', content: accumulated, created_at: new Date().toISOString() }]);
        }
      },
    });
  }, [input, streaming, convId, convStatus, onConvCreated]);

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setStreaming(false);
    if (streamText) {
      setMessages(prev => [...prev, { role: 'assistant', content: streamText, created_at: new Date().toISOString() }]);
    }
    setStreamText('');
  }

  const isCancelled = convStatus === 'cancelled';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>
            {convId ? 'Conversation' : 'New Chat'}
          </span>
          {convId && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--text3)', background: 'var(--bg3)',
              border: '1px solid var(--border)', borderRadius: 4,
              padding: '1px 6px',
            }}>{convId.slice(0, 8)}</span>
          )}
          {isCancelled && (
            <span style={{
              fontSize: 11, color: 'var(--red)', background: 'var(--red-dim)',
              border: '1px solid rgba(248,113,113,0.2)',
              borderRadius: 4, padding: '1px 8px', fontWeight: 500,
            }}>CANCELLED</span>
          )}
        </div>
        {lastMeta && (
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            <span title="Latency">{lastMeta.latency_ms}ms</span>
            <span title="Tokens">↑{lastMeta.input_tokens} ↓{lastMeta.output_tokens}</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 8px' }}>
        {messages.length === 0 && !streaming && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', gap: 12,
            color: 'var(--text3)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 40 }}>⬡</div>
            <div style={{ fontSize: 15, color: 'var(--text2)', fontWeight: 500 }}>Start a conversation</div>
            <div style={{ fontSize: 13, maxWidth: 340 }}>
              Messages are logged with full inference metadata — latency, tokens, cost estimates, and PII redaction.
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <Message key={i} role={msg.role} content={msg.content} />
        ))}

        {streaming && streamText && (
          <Message role="assistant" content={streamText} isStreaming />
        )}

        {streaming && !streamText && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text3)', fontSize: 13, marginBottom: 16 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'var(--accent-dim)', border: '1px solid var(--accent-glow)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, color: 'var(--accent)', fontFamily: 'var(--mono)', fontWeight: 700,
            }}>A</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--text3)', animation: `pulse 1.2s ease ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '10px 14px', background: 'var(--red-dim)',
            border: '1px solid rgba(248,113,113,0.25)',
            borderRadius: 'var(--radius)', color: 'var(--red)',
            fontSize: 13, marginBottom: 12,
          }}>
            ⚠ {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '12px 16px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg2)',
        flexShrink: 0,
      }}>
        {isCancelled ? (
          <div style={{
            textAlign: 'center', padding: '12px',
            color: 'var(--text3)', fontSize: 13,
            background: 'var(--red-dim)', borderRadius: 'var(--radius)',
            border: '1px solid rgba(248,113,113,0.15)',
          }}>
            This conversation has been cancelled. Start a new chat to continue.
          </div>
        ) : (
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-end',
            background: 'var(--bg3)', border: '1px solid var(--border2)',
            borderRadius: 'var(--radius2)', padding: '8px 8px 8px 14px',
            transition: 'border-color .15s',
          }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message… (Enter to send, Shift+Enter for newline)"
              disabled={streaming || isCancelled}
              rows={1}
              style={{
                flex: 1, background: 'transparent', border: 'none',
                color: 'var(--text)', fontSize: 14, resize: 'none',
                outline: 'none', lineHeight: 1.5, maxHeight: 140,
                overflowY: 'auto', padding: 0,
              }}
              onInput={e => {
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
              }}
            />
            {streaming ? (
              <button onClick={handleStop} style={{
                background: 'var(--red-dim)', border: '1px solid rgba(248,113,113,0.3)',
                color: 'var(--red)', borderRadius: 6, padding: '6px 12px',
                fontSize: 12, fontWeight: 600, flexShrink: 0,
              }}>Stop</button>
            ) : (
              <button onClick={send} disabled={!input.trim()} style={{
                background: input.trim() ? 'var(--accent)' : 'var(--bg4)',
                border: 'none', color: input.trim() ? '#000' : 'var(--text3)',
                borderRadius: 6, padding: '6px 14px',
                fontSize: 13, fontWeight: 600, flexShrink: 0,
                transition: 'all .15s',
              }}>Send</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
