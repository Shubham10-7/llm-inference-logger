/**
 * LLM Inference Logger SDK
 * Wraps Anthropic (and other provider) calls, capturing full metadata
 * and sending logs to the ingestion pipeline.
 */

const { v4: uuidv4 } = require('uuid');

const PII_PATTERNS = [
  { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replace: '[EMAIL]' },
  { re: /(\+?\d[\s.-]?)?(\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/g, replace: '[PHONE]' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: '[SSN]' },
  { re: /\b(sk-|pk-|api-)[A-Za-z0-9_-]{20,}/g, replace: '[API_KEY]' },
];

function redactPII(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const p of PII_PATTERNS) result = result.replace(p.re, p.replace);
  return result;
}

class InferenceLogger {
  constructor({ ingestionUrl, provider = 'anthropic', model, flushInterval = 2000, maxBufferSize = 20 }) {
    this.ingestionUrl = ingestionUrl;
    this.provider = provider;
    this.model = model;
    this.buffer = [];
    this.maxBufferSize = maxBufferSize;

    // Flush buffer periodically
    this.flushTimer = setInterval(() => this.flush(), flushInterval);
    if (this.flushTimer.unref) this.flushTimer.unref(); // don't block process exit
  }

  async _send(payload) {
    try {
      const res = await fetch(`${this.ingestionUrl}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.warn('[SDK] Ingest non-200:', res.status);
    } catch (e) {
      // Buffer on failure to avoid losing logs
      this.buffer.push(payload);
      console.warn('[SDK] Ingest failed, buffered:', e.message);
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.maxBufferSize);
    try {
      await fetch(`${this.ingestionUrl}/ingest/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: batch }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      // re-buffer on failure (with cap to avoid memory leak)
      if (this.buffer.length < 500) this.buffer.push(...batch);
      console.warn('[SDK] Batch flush failed:', e.message);
    }
  }

  /**
   * Wrap an Anthropic streaming call with full metadata capture.
   * Returns { stream, messageId } where stream is the original Anthropic stream.
   */
  async wrapStream({ anthropic, messages, system, conversationId, onChunk, onComplete }) {
    const model = this.model;
    const requestTs = new Date().toISOString();
    const startTime = Date.now();
    let firstTokenTime = null;
    let chunkCount = 0;
    let fullText = '';

    const stream = await anthropic.messages.stream({
      model,
      max_tokens: 1024,
      system: system || 'You are a helpful assistant.',
      messages,
    });

    // Process the stream and forward chunks
    const processedStream = (async function* () {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (firstTokenTime === null) firstTokenTime = Date.now() - startTime;
          fullText += event.delta.text;
          chunkCount++;
          if (onChunk) onChunk(event.delta.text);
          yield event.delta.text;
        }
      }
    })();

    // Attach a .finalMessage() style getter
    processedStream.getMetrics = async () => {
      const final = await stream.finalMessage();
      return {
        inputTokens: final.usage?.input_tokens,
        outputTokens: final.usage?.output_tokens,
        stopReason: final.stop_reason,
      };
    };

    // Fire-and-forget log after stream completes
    (async () => {
      try {
        const final = await stream.finalMessage();
        const responseTs = new Date().toISOString();
        const latency = Date.now() - startTime;

        const log = {
          conversation_id: conversationId,
          provider: this.provider,
          model,
          request_timestamp: requestTs,
          response_timestamp: responseTs,
          latency_ms: latency,
          time_to_first_token_ms: firstTokenTime,
          input_tokens: final.usage?.input_tokens,
          output_tokens: final.usage?.output_tokens,
          status: 'success',
          input_preview: redactPII((messages.at(-1)?.content || '').slice(0, 200)),
          output_preview: redactPII(fullText.slice(0, 200)),
          is_streaming: true,
          stream_chunks: chunkCount,
          extra_metadata: { stop_reason: final.stop_reason },
        };

        await this._send(log);
        if (onComplete) onComplete(fullText, final);
      } catch (e) {
        await this._send({
          conversation_id: conversationId,
          provider: this.provider,
          model,
          request_timestamp: requestTs,
          response_timestamp: new Date().toISOString(),
          latency_ms: Date.now() - startTime,
          status: 'error',
          error_message: e.message,
          is_streaming: true,
        });
      }
    })();

    return processedStream;
  }

  /**
   * Wrap a standard (non-streaming) Anthropic call.
   */
  async wrapCall({ anthropic, messages, system, conversationId }) {
    const model = this.model;
    const requestTs = new Date().toISOString();
    const startTime = Date.now();

    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: system || 'You are a helpful assistant.',
        messages,
      });

      const responseTs = new Date().toISOString();
      const latency = Date.now() - startTime;
      const outputText = response.content[0]?.text || '';

      await this._send({
        conversation_id: conversationId,
        provider: this.provider,
        model,
        request_timestamp: requestTs,
        response_timestamp: responseTs,
        latency_ms: latency,
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
        status: 'success',
        http_status: 200,
        input_preview: redactPII((messages.at(-1)?.content || '').slice(0, 200)),
        output_preview: redactPII(outputText.slice(0, 200)),
        is_streaming: false,
        extra_metadata: { stop_reason: response.stop_reason },
      });

      return response;
    } catch (e) {
      const responseTs = new Date().toISOString();
      await this._send({
        conversation_id: conversationId,
        provider: this.provider,
        model,
        request_timestamp: requestTs,
        response_timestamp: responseTs,
        latency_ms: Date.now() - startTime,
        status: e.status === 408 ? 'timeout' : 'error',
        error_code: e.error?.type || 'unknown',
        error_message: e.message,
        http_status: e.status,
        is_streaming: false,
      });
      throw e;
    }
  }

  destroy() {
    clearInterval(this.flushTimer);
    this.flush(); // best-effort final flush
  }
}

module.exports = { InferenceLogger, redactPII };
