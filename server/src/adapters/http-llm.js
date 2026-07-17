'use strict';

/**
 * Answers by calling any OpenAI-compatible /chat/completions endpoint.
 *
 * That covers a lot of ground with one adapter: OpenAI itself, Ollama,
 * LM Studio, vLLM, llama.cpp's server, OpenRouter, Groq, Together, and most
 * corporate gateways. Point ASK_HTTP_BASE_URL at the root that has
 * /chat/completions under it.
 *
 * This one costs money per question, unlike claude-cli. It is here so the
 * project is not welded to one vendor.
 */
function createHttpLlmAdapter(config, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const { baseUrl, apiKey, model, maxTokens, temperature } = config.http;

  if (typeof fetchFn !== 'function') {
    throw new Error('no fetch available; use Node 18+ or pass one in');
  }

  function buildRequest(question) {
    const messages = [];
    if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt });
    messages.push({ role: 'user', content: question });

    const body = { model, messages, max_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    return { url: `${baseUrl}/chat/completions`, method: 'POST', headers, body };
  }

  /** Pulls the text out, tolerating the shapes servers actually return. */
  function readResponse(json) {
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    const message = choice && choice.message;
    let text = '';
    if (message && typeof message.content === 'string') {
      text = message.content;
    } else if (message && Array.isArray(message.content)) {
      // Some gateways return content as blocks the way Anthropic's API does.
      text = message.content
        .map((part) => (typeof part === 'string' ? part : part && part.text) || '')
        .join('');
    } else if (choice && typeof choice.text === 'string') {
      text = choice.text;
    }
    const reply = text.trim();
    if (!reply) throw new Error('LLM returned no text');
    return { reply };
  }

  async function ask(question) {
    const req = buildRequest(question);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`LLM responded ${res.status}: ${raw.slice(0, 300)}`);
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`LLM returned non-JSON: ${raw.slice(0, 200)}`);
      }
      return readResponse(json);
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`LLM timed out after ${config.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { name: 'http', ask, buildRequest, readResponse };
}

module.exports = { createHttpLlmAdapter };
