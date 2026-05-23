const CHATBOT = import.meta.env.VITE_CHATBOT_URL || 'http://localhost:3001';
const INGESTION = import.meta.env.VITE_INGESTION_URL || 'http://localhost:4000';

async function json(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

// Conversations
export const listConversations = () => json(`${CHATBOT}/conversations`);
export const getConversation = (id) => json(`${CHATBOT}/conversations/${id}`);
export const newConversation = () => json(`${CHATBOT}/conversations`, { method: 'POST', body: '{}' });
export const cancelConversation = (id) => json(`${CHATBOT}/conversations/${id}/cancel`, { method: 'POST', body: '{}' });

// Chat (streaming)
export function streamChat({ message, conversationId, onChunk, onDone, onError, signal }) {
  const url = `${CHATBOT}/chat`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId }),
    signal,
  }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let meta = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        const lines = part.split('\n');
        let eventType = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (eventType === 'chunk') onChunk?.(parsed.text);
          if (eventType === 'start') meta = { ...meta, ...parsed };
          if (eventType === 'done') { meta = { ...meta, ...parsed }; onDone?.(meta); }
          if (eventType === 'error') onError?.(parsed.error);
        } catch {}
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') onError?.(err.message);
  });
}

// Metrics
export const getMetrics = (hours = 24) => json(`${INGESTION}/metrics?hours=${hours}`);
export const getLogs = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return json(`${INGESTION}/logs${q ? '?' + q : ''}`);
};

// SSE for live events
export function connectLiveEvents(onEvent) {
  const es = new EventSource(`${INGESTION}/events/stream`);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch {}
  };
  return es;
}
