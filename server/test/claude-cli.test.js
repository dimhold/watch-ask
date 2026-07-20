'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createClaudeCliAdapter } = require('../src/adapters/claude-cli');

const noEnvFile = { envFile: path.join(os.tmpdir(), 'watch-ask-no-such-file.env') };

function config(extra = {}) {
  return loadConfig(
    { ASK_TOKEN: 'a'.repeat(32), ASK_WORK_DIR: '/work/project', ...extra },
    noEnvFile
  );
}

/**
 * A stand-in for a spawned CLI. The model is never called: what is under test
 * is the shape of the command and how its output is read.
 */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (d) => calls.at(-1).stdin.push(d), end() {}, on() {} };
    child.kill = () => calls.at(-1).killed = true;
    calls.push({ bin, args, options, stdin: [], killed: false });
    setImmediate(() => script(child));
    return child;
  };
  return { spawn, calls };
}

const okEnvelope = (result) =>
  JSON.stringify({ type: 'result', is_error: false, result, total_cost_usd: 0.071 });

test('the question goes over stdin, never as an argument', async () => {
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', okEnvelope('two sentences.'));
    child.emit('close', 0);
  });
  const adapter = createClaudeCliAdapter(config(), { spawn });

  await adapter.ask('rm -rf / ; echo "$(whoami)"');

  const call = calls[0];
  assert.deepStrictEqual(call.stdin, ['rm -rf / ; echo "$(whoami)"']);
  assert.ok(
    !call.args.some((a) => a.includes('whoami')),
    'the dictated text must not appear in argv'
  );
  assert.strictEqual(call.options.shell, false, 'no shell, ever');
});

test('the command is headless, JSON, and scoped to the work dir', async () => {
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', okEnvelope('ok'));
    child.emit('close', 0);
  });
  const adapter = createClaudeCliAdapter(
    config({ ASK_ADD_DIRS: '/work/other', ASK_CLAUDE_MODEL: 'claude-sonnet-4-5' }),
    { spawn }
  );

  await adapter.ask('what changed?');
  const { bin, args, options } = calls[0];

  assert.strictEqual(bin, 'claude');
  assert.strictEqual(options.cwd, '/work/project');
  assert.ok(args.includes('-p'), 'headless');
  assert.deepStrictEqual(
    args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'json']
  );
  assert.deepStrictEqual(
    args.slice(args.indexOf('--model'), args.indexOf('--model') + 2),
    ['--model', 'claude-sonnet-4-5']
  );
  assert.deepStrictEqual(
    args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2),
    ['--add-dir', '/work/other']
  );
  assert.ok(args.includes('--append-system-prompt'));
});

test('nothing resumes a session: every question starts clean', () => {
  const adapter = createClaudeCliAdapter(config(), { spawn: fakeSpawn(() => {}).spawn });
  const args = adapter.buildArgs();
  for (const forbidden of ['--resume', '--continue', '--session-id']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not appear: this is stateless Q&A`);
  }
});

test('permissions stay at the configured mode and are not silently widened', () => {
  const strict = createClaudeCliAdapter(config(), { spawn: fakeSpawn(() => {}).spawn });
  assert.ok(!strict.buildArgs().includes('bypassPermissions'));

  const wide = createClaudeCliAdapter(
    config({ ASK_CLAUDE_PERMISSION_MODE: 'bypassPermissions' }),
    { spawn: fakeSpawn(() => {}).spawn }
  );
  const args = wide.buildArgs();
  assert.deepStrictEqual(
    args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'when asked for explicitly it is passed through unchanged'
  );
});

test('the reply and the cost come out of the JSON envelope', async () => {
  const { spawn } = fakeSpawn((child) => {
    child.stdout.emit('data', okEnvelope('  Three repos moved.  '));
    child.emit('close', 0);
  });
  const result = await createClaudeCliAdapter(config(), { spawn }).ask('q');
  assert.strictEqual(result.reply, 'Three repos moved.');
  assert.strictEqual(result.costUsd, 0.071);
});

test('an API error hidden in stdout is surfaced, not read as success', async () => {
  // The CLI can exit 0 with an empty stderr and the real reason in the JSON.
  const { spawn } = fakeSpawn((child) => {
    child.stdout.emit('data', JSON.stringify({ is_error: true, result: 'rate limit reached' }));
    child.emit('close', 0);
  });
  await assert.rejects(
    createClaudeCliAdapter(config(), { spawn }).ask('q'),
    /rate limit reached/
  );
});

test('a non-zero exit reports the exit code and stderr', async () => {
  const { spawn } = fakeSpawn((child) => {
    child.stderr.emit('data', 'boom');
    child.emit('close', 1);
  });
  await assert.rejects(createClaudeCliAdapter(config(), { spawn }).ask('q'), /exited 1: boom/);
});

test('unparseable output does not pass for an answer', async () => {
  const { spawn } = fakeSpawn((child) => {
    child.stdout.emit('data', 'not json at all');
    child.emit('close', 0);
  });
  await assert.rejects(createClaudeCliAdapter(config(), { spawn }).ask('q'), /stdout: not json/);
});

test('a missing binary says which setting fixes it', async () => {
  const { spawn } = fakeSpawn((child) => {
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  });
  await assert.rejects(createClaudeCliAdapter(config(), { spawn }).ask('q'), /ASK_CLAUDE_BIN/);
});

test('a backend that never answers is killed at the timeout', async () => {
  const { spawn, calls } = fakeSpawn(() => {}); // says nothing, ever
  const adapter = createClaudeCliAdapter(config({ ASK_TIMEOUT_MS: '30' }), { spawn });
  await assert.rejects(adapter.ask('q'), /timed out after 30ms/);
  assert.strictEqual(calls[0].killed, true);
});
