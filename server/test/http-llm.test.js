'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createHttpLlmAdapter } = require('../src/adapters/http-llm');

const noEnvFile = { envFile: path.join(os.tmpdir(), 'watch-ask-no-such-file.env') };

function config(extra = {}) {
  return loadConfig(
    {
      ASK_TOKEN: 'a'.repeat(32),
      ASK_ADAPTER: 'http',
      ASK_HTTP_BASE_URL: 'https://api.example.test/v1',
      ASK_HTTP_MODEL: 'some-model',
      ASK_HTTP_API_KEY: 'secret-key',
      ...extra,
    },
    noEnvFile
  );
}

/** Records the outgoing call and replies with whatever the test wants. */
function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === 'function' ? reply() : reply;
  };
  return { fetch, calls };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('the request is a chat completion carrying the system prompt and the question', async () => {
  const { fetch, calls } = fakeFetch(
    jsonResponse(200, { choices: [{ message: { content: 'Two sentences.' } }] })
  );
  const adapter = createHttpLlmAdapter(config(), { fetch });

  const result = await adapter.ask('what is on fire?');

  assert.strictEqual(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer secret-key');
  const body = JSON.parse(calls[0].init.body);
  assert.strictEqual(body.model, 'some-model');
  assert.strictEqual(body.stream, false);
  assert.strictEqual(body.max_tokens, 512);
  assert.strictEqual(body.messages[0].role, 'system');
  assert.deepStrictEqual(body.messages[1], { role: 'user', content: 'what is on fire?' });
  assert.strictEqual(result.reply, 'Two sentences.');
});

test('no api key means no Authorization header, which is how local servers want it', () => {
  const adapter = createHttpLlmAdapter(config({ ASK_HTTP_API_KEY: '' }), { fetch: async () => {} });
  assert.strictEqual(adapter.buildRequest('q').headers.Authorization, undefined);
});

test('temperature is only sent when it was set', () => {
  const off = createHttpLlmAdapter(config(), { fetch: async () => {} });
  assert.strictEqual('temperature' in off.buildRequest('q').body, false);

  const on = createHttpLlmAdapter(config({ ASK_HTTP_TEMPERATURE: '0.2' }), { fetch: async () => {} });
  assert.strictEqual(on.buildRequest('q').body.temperature, 0.2);
});

test('block-style content is joined instead of dropped', () => {
  const adapter = createHttpLlmAdapter(config(), { fetch: async () => {} });
  const result = adapter.readResponse({
    choices: [{ message: { content: [{ text: 'half ' }, { text: 'and half' }] } }],
  });
  assert.strictEqual(result.reply, 'half and half');
});

test('an empty completion is an error, not an empty answer read aloud', () => {
  const adapter = createHttpLlmAdapter(config(), { fetch: async () => {} });
  assert.throws(() => adapter.readResponse({ choices: [{ message: { content: '   ' } }] }), /no text/);
  assert.throws(() => adapter.readResponse({ choices: [] }), /no text/);
});

test('an error status is reported with the body attached', async () => {
  const { fetch } = fakeFetch(jsonResponse(429, { error: 'slow down' }));
  await assert.rejects(createHttpLlmAdapter(config(), { fetch }).ask('q'), /responded 429/);
});

test('an HTML error page does not parse as an answer', async () => {
  const { fetch } = fakeFetch(jsonResponse(200, '<html>gateway</html>'));
  await assert.rejects(createHttpLlmAdapter(config(), { fetch }).ask('q'), /non-JSON/);
});

test('an aborted call reports a timeout rather than a stack trace', async () => {
  const { fetch } = fakeFetch(() => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  await assert.rejects(
    createHttpLlmAdapter(config({ ASK_TIMEOUT_MS: '50' }), { fetch }).ask('q'),
    /timed out after 50ms/
  );
});
