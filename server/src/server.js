'use strict';

const http = require('http');
const crypto = require('crypto');

/**
 * The responder.
 *
 * Two ways to ask the same question:
 *
 *   POST /ask            {"question": "..."}  -> 200 {"reply": "..."}
 *   POST /ask?mode=async {"question": "..."}  -> 202 {"jobId": "..."}
 *   GET  /result/<jobId>                      -> 200 {"status": "...", ...}
 *   GET  /health                              -> 200 {"ok": true}
 *
 * The synchronous form is the contract. The async form exists because a local
 * agent can think for minutes while anything in front of it, a Cloudflare
 * tunnel or a phone radio, cuts the socket at around sixty seconds and throws
 * a finished answer away. Splitting the wait into short polls means the backend
 * can take as long as it likes.
 *
 * There is no memory between questions on purpose. No transcript, no session
 * file, no profile. Each question arrives, gets answered and is forgotten.
 */

/** Length-independent compare, so a wrong token leaks nothing through timing. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error('question too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createApp(config, adapter, { logger = console } = {}) {
  /** Finished answers waiting to be collected, keyed by job id. */
  const jobs = new Map();

  function sweepJobs(now = Date.now()) {
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > config.jobTtlMs) jobs.delete(id);
    }
  }

  function note(question) {
    return config.logQuestions ? ` ${question.slice(0, 60)}` : '';
  }

  async function answer(question) {
    const startedAt = Date.now();
    const result = await adapter.ask(question);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const cost = result.costUsd ? ` ($${result.costUsd.toFixed(3)} equiv)` : '';
    logger.log(`answered in ${seconds}s${cost}${note(question)}`);
    return result.reply;
  }

  async function runJob(id, question) {
    const job = jobs.get(id);
    if (!job) return;
    try {
      job.reply = await answer(question);
      job.status = 'done';
    } catch (e) {
      logger.error(`failed: ${e.message}`);
      job.status = 'failed';
      job.error = e.message;
    } finally {
      job.finishedAt = Date.now();
      sweepJobs();
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    // Unauthenticated on purpose: it answers "is anything listening on this
    // port", which is what you are asking when the watch says nothing at all.
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, adapter: adapter.name });
    }

    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ') || !tokenMatches(header.slice(7), config.token)) {
      return send(res, 401, { error: 'unauthorized' });
    }

    const result = url.pathname.match(/^\/result\/([\w-]+)$/);
    if (req.method === 'GET' && result) {
      const job = jobs.get(result[1]);
      if (!job) return send(res, 404, { error: 'no such job' });
      return send(res, 200, {
        status: job.status,
        reply: job.reply,
        error: job.error,
        seconds: Math.round((Date.now() - job.startedAt) / 1000),
      });
    }

    if (req.method !== 'POST' || url.pathname !== '/ask') {
      return send(res, 404, { error: 'not found' });
    }

    let raw;
    try {
      raw = await readBody(req, config.maxQuestionBytes);
    } catch (e) {
      if (!res.headersSent && res.writable) send(res, 413, { error: e.message });
      return;
    }

    let question;
    try {
      const parsed = JSON.parse(raw);
      question = String(parsed.question ?? '').trim();
    } catch {
      return send(res, 400, { error: 'body must be JSON with a "question" field' });
    }
    if (!question) return send(res, 400, { error: 'empty question' });

    if (url.searchParams.get('mode') === 'async') {
      const id = crypto.randomUUID();
      jobs.set(id, { status: 'working', startedAt: Date.now() });
      send(res, 202, { jobId: id });
      runJob(id, question);
      return;
    }

    try {
      send(res, 200, { reply: await answer(question) });
    } catch (e) {
      logger.error(`failed: ${e.message}`);
      send(res, 502, { error: e.message });
    }
  }

  return { handle, jobs, sweepJobs };
}

function createServer(config, adapter, options) {
  const app = createApp(config, adapter, options);
  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: e.message });
    });
  });
  // A long-running local agent must not have its socket closed underneath it.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.setTimeout(config.timeoutMs + 30000);
  return { server, app };
}

module.exports = { createApp, createServer, tokenMatches };
