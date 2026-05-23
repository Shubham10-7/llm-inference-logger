CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  content_preview TEXT GENERATED ALWAYS AS (LEFT(content, 200)) STORED,
  token_count INTEGER,
  sequence_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inference_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_timestamp TIMESTAMPTZ NOT NULL,
  response_timestamp TIMESTAMPTZ,
  latency_ms INTEGER,
  time_to_first_token_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost_usd NUMERIC(10, 6),
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'cancelled', 'timeout')),
  error_code TEXT,
  error_message TEXT,
  http_status INTEGER,
  input_preview TEXT,
  output_preview TEXT,
  is_streaming BOOLEAN DEFAULT FALSE,
  stream_chunks INTEGER,
  raw_response_headers JSONB,
  extra_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_sequence ON messages(conversation_id, sequence_number);
CREATE INDEX idx_inference_logs_conversation_id ON inference_logs(conversation_id);
CREATE INDEX idx_inference_logs_created_at ON inference_logs(created_at DESC);
CREATE INDEX idx_inference_logs_provider_model ON inference_logs(provider, model);
CREATE INDEX idx_inference_logs_status ON inference_logs(status);
CREATE INDEX idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_created_at ON conversations(created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
