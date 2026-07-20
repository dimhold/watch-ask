'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createServer, tokenMatches } = require('../src/server');

const TOKEN = 'a'.repeat(32);
const noEnvFile = { envFile: path.join(os.tmpdir(), 'watch-ask-no-such-file.env') };
const quiet = { logger: { log() {}, error() {} } };

/** Boots a real server on a free port with a fake adapter behind it. */
async function withServer(adapter, extraEnv, run) {
  const config = loadConfig({ ASK_TOKEN: TOKEN, ...extraEnv }, noEnvFile);
  const { server } = createServer(config, adapter, quiet);
  // Port 0 lets the OS pick a free one, so tests never collide with a real run.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (pathname, init = {}) =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    });

  const askJson = async (body, query = '') => {
    const res = await call(`/ask${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    await run({ base, call, askJson });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const echo = { name: 'echo', ask: async (q) => ({ reply: `heard: ${q}` }) };
const broken = { name: 'broken', ask: async () => { throw new Error('backend is down'); } };

test('a question in gets a reply out', async () => {
  await withServer(echo, {}, async ({ askJson }) => {
    const { status, json } = await askJson({ question: 'what moved today?' });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { reply: 'heard: what moved today?' });
  });
});

test('surrounding whitespace on a dictated question is trimmed', async () => {
  await withServer(echo, {}, async ({ askJson }) => {
    const { json } = await askJson({ question: '  spoken slowly  ' });
    assert.strictEqual(json.reply, 'heard: spoken slowly');
  });
});

test('no token, wrong token and a bare token are all refused', async () => {
  await withServer(echo, {}, async ({ base }) => {
    const post = (headers) =>
      fetch(`${base}/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'q' }) });

    assert.strictEqual((await post({})).status, 401);
    assert.strictEqual((await post({ Authorization: `Bearer ${'b'.repeat(32)}` })).status, 401);
    assert.strictEqual((await post({ Authorization: TOKEN })).status, 401, 'must say Bearer');
    assert.strictEqual((await post({ Authorization: 'Bearer ' })).status, 401);
  });
});

test('a token of the wrong length is refused rather than crashing the compare', () => {
  assert.strictEqual(tokenMatches('short', TOKEN), false);
  assert.strictEqual(tokenMatches(TOKEN, TOKEN), true);
});

test('health answers without a token, because that is what you check first', async () => {
  await withServer(echo, {}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, adapter: 'echo' });
  });
});

test('a malformed body and an empty question are told apart', async () => {
  await withServer(echo, {}, async ({ askJson }) => {
    const bad = await askJson('{not json');
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /must be JSON/);

    const empty = await askJson({ question: '   ' });
    assert.strictEqual(empty.status, 400);
    assert.match(empty.json.error, /empty question/);

    const missing = await askJson({ text: 'wrong field name' });
    assert.strictEqual(missing.status, 400);
  });
});

test('an oversized body is cut off instead of being buffered', async () => {
  await withServer(echo, { ASK_MAX_QUESTION_BYTES: '64' }, async ({ askJson }) => {
    await assert.rejects(
      askJson({ question: 'x'.repeat(5000) }),
      'the connection is dropped rather than reading 5kB of dictation'
    );
  });
});

test('a failing backend is a 502 with the reason, not a hang', async () => {
  await withServer(broken, {}, async ({ askJson }) => {
    const { status, json } = await askJson({ question: 'q' });
    assert.strictEqual(status, 502);
    assert.strictEqual(json.error, 'backend is down');
  });
});

test('unknown routes and methods are 404', async () => {
  await withServer(echo, {}, async ({ call }) => {
    assert.strictEqual((await call('/nope')).status, 404);
    assert.strictEqual((await call('/ask')).status, 404, 'GET /ask is not a thing');
  });
});

test('async mode hands back a job id and then the answer', async () => {
  let release;
  const slow = {
    name: 'slow',
    ask: (q) => new Promise((resolve) => (release = () => resolve({ reply: `late: ${q}` }))),
  };

  await withServer(slow, {}, async ({ call, askJson }) => {
    const started = await askJson({ question: 'takes a while' }, '?mode=async');
    assert.strictEqual(started.status, 202, 'returns immediately, before the answer exists');
    assert.match(started.json.jobId, /^[0-9a-f-]{36}$/);

    const working = await (await call(`/result/${started.json.jobId}`)).json();
    assert.strictEqual(working.status, 'working');
    assert.strictEqual(typeof working.seconds, 'number');

    release();
    await new Promise((r) => setImmediate(r));

    const done = await (await call(`/result/${started.json.jobId}`)).json();
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.reply, 'late: takes a while');
  });
});

test('an async failure is collectable too, so the watch is never left waiting', async () => {
  await withServer(broken, {}, async ({ call, askJson }) => {
    const started = await askJson({ question: 'q' }, '?mode=async');
    await new Promise((r) => setTimeout(r, 20));
    const result = await (await call(`/result/${started.json.jobId}`)).json();
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'backend is down');
  });
});

test('collecting an unknown job is a 404, and results need the token', async () => {
  await withServer(echo, {}, async ({ base, call }) => {
    assert.strictEqual((await call('/result/deadbeef')).status, 404);
    assert.strictEqual((await fetch(`${base}/result/deadbeef`)).status, 401);
  });
});

test('finished jobs are swept, so nothing spoken sits in memory forever', async () => {
  const config = loadConfig({ ASK_TOKEN: TOKEN, ASK_JOB_TTL_MS: '1000' }, noEnvFile);
  const { app, server } = createServer(config, echo, quiet);
  server.close();

  app.jobs.set('old', { status: 'done', reply: 'x', startedAt: 0, finishedAt: Date.now() - 5000 });
  app.jobs.set('fresh', { status: 'done', reply: 'y', startedAt: 0, finishedAt: Date.now() });
  app.jobs.set('running', { status: 'working', startedAt: Date.now() });

  app.sweepJobs();

  assert.strictEqual(app.jobs.has('old'), false);
  assert.strictEqual(app.jobs.has('fresh'), true);
  assert.strictEqual(app.jobs.has('running'), true, 'a job still working is never swept');
});

test('nothing is remembered between questions', async () => {
  const seen = [];
  const recorder = {
    name: 'recorder',
    ask: async (q) => {
      seen.push(q);
      return { reply: 'ok' };
    },
  };
  await withServer(recorder, {}, async ({ askJson }) => {
    await askJson({ question: 'my name is Ada' });
    await askJson({ question: 'what is my name?' });
    assert.deepStrictEqual(seen, ['my name is Ada', 'what is my name?']);
    assert.strictEqual(seen[1], 'what is my name?', 'the second call carries no trace of the first');
  });
});
