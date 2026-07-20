'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, parseEnvFile } = require('../src/config');

/** A minimal environment that passes validation, so each test varies one thing. */
const base = () => ({ ASK_TOKEN: 'a'.repeat(32) });

/** Points loadConfig at a file that does not exist, isolating it from a real .env. */
const noEnvFile = { envFile: path.join(os.tmpdir(), 'watch-ask-no-such-file.env') };

test('parseEnvFile reads pairs and ignores comments and blanks', () => {
  const parsed = parseEnvFile(['# comment', '', 'A=1', 'B = two ', 'not a pair'].join('\n'));
  assert.deepStrictEqual(parsed, { A: '1', B: 'two' });
});

test('parseEnvFile strips surrounding quotes but keeps inner ones', () => {
  const parsed = parseEnvFile(`A="has spaces"\nB='single'\nC="say ""hi"`);
  assert.strictEqual(parsed.A, 'has spaces');
  assert.strictEqual(parsed.B, 'single');
  assert.strictEqual(parsed.C, 'say ""hi');
});

test('a real environment variable beats the .env file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-ask-')), '.env');
  fs.writeFileSync(file, `ASK_TOKEN=${'f'.repeat(32)}\nASK_PORT=9999\n`);

  const config = loadConfig({ ASK_PORT: '1234' }, { envFile: file });
  assert.strictEqual(config.port, 1234, 'process env wins');
  assert.strictEqual(config.token, 'f'.repeat(32), 'file fills what env omits');
});

test('defaults are the documented ones', () => {
  const config = loadConfig(base(), noEnvFile);
  assert.strictEqual(config.adapter, 'claude-cli');
  assert.strictEqual(config.port, 8787);
  assert.strictEqual(config.host, '0.0.0.0');
  assert.strictEqual(config.timeoutMs, 300000);
  assert.strictEqual(config.logQuestions, false, 'questions are not logged unless asked for');
  assert.strictEqual(config.claude.permissionMode, 'default', 'never bypassPermissions by default');
  assert.match(config.systemPrompt, /sentences/);
});

test('a missing token refuses to start', () => {
  assert.throws(() => loadConfig({}, noEnvFile), /ASK_TOKEN is not set/);
});

test('a short token refuses to start', () => {
  assert.throws(() => loadConfig({ ASK_TOKEN: 'short' }, noEnvFile), /too short/);
});

test('the http adapter demands a base url and a model', () => {
  assert.throws(
    () => loadConfig({ ...base(), ASK_ADAPTER: 'http' }, noEnvFile),
    /ASK_HTTP_BASE_URL/
  );
  assert.throws(
    () => loadConfig(
      { ...base(), ASK_ADAPTER: 'http', ASK_HTTP_BASE_URL: 'http://x/v1' },
      noEnvFile
    ),
    /ASK_HTTP_MODEL/
  );
});

test('a trailing slash on the base url does not become a double slash', () => {
  const config = loadConfig(
    { ...base(), ASK_ADAPTER: 'http', ASK_HTTP_BASE_URL: 'http://x/v1//', ASK_HTTP_MODEL: 'm' },
    noEnvFile
  );
  assert.strictEqual(config.http.baseUrl, 'http://x/v1');
});

test('booleans accept the spellings people actually type', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.strictEqual(loadConfig({ ...base(), ASK_LOG_QUESTIONS: value }, noEnvFile).logQuestions, true, value);
  }
  for (const value of ['0', 'false', 'no', 'off', '']) {
    assert.strictEqual(loadConfig({ ...base(), ASK_LOG_QUESTIONS: value }, noEnvFile).logQuestions, false, value);
  }
});

test('a nonsense number is rejected rather than silently becoming NaN', () => {
  assert.throws(() => loadConfig({ ...base(), ASK_PORT: 'eight' }, noEnvFile), /positive integer/);
  assert.throws(() => loadConfig({ ...base(), ASK_TIMEOUT_MS: '-5' }, noEnvFile), /positive integer/);
});

test('extra directories are split and trimmed', () => {
  const config = loadConfig({ ...base(), ASK_ADD_DIRS: ' /a , /b ,, ' }, noEnvFile);
  assert.deepStrictEqual(config.claude.addDirs, ['/a', '/b']);
});
