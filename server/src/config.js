'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Reads a KEY=VALUE file the way a shell would, minus the shell. Only used to
 * seed process.env for local runs, so a real environment always wins and
 * nothing here can override what an operator set deliberately.
 */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Loads .env into env without clobbering anything already set. */
function loadEnvFile(file, env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are answering on a smartwatch screen roughly 45mm across,',
  'and the answer is also read aloud while the person is walking.',
  'So: at most two or three short sentences, no lists, no headings, no markdown,',
  'no code blocks. Say the useful part first. If the honest answer is',
  "\"I don't know\", say that instead of padding.",
].join(' ');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

/**
 * Builds the runtime config from the environment.
 *
 * Everything is overridable and nothing is baked into a source file, because
 * the two values that matter (the token and the working directory) are the two
 * you must never publish.
 */
function loadConfig(env = process.env, { envFile } = {}) {
  const merged = { ...env };
  const file = envFile ?? path.join(__dirname, '..', '.env');
  loadEnvFile(file, merged);

  const adapter = (merged.ASK_ADAPTER || 'claude-cli').trim();
  const token = (merged.ASK_TOKEN || '').trim();

  const config = {
    adapter,
    port: int(merged.ASK_PORT, 8787, 'ASK_PORT'),
    host: (merged.ASK_HOST || '0.0.0.0').trim(),
    token,
    /** Answers longer than this are given up on rather than left hanging. */
    timeoutMs: int(merged.ASK_TIMEOUT_MS, 300000, 'ASK_TIMEOUT_MS'),
    /** A question is a sentence, not a payload. */
    maxQuestionBytes: int(merged.ASK_MAX_QUESTION_BYTES, 32000, 'ASK_MAX_QUESTION_BYTES'),
    /** How long a finished async answer stays collectable. */
    jobTtlMs: int(merged.ASK_JOB_TTL_MS, 1800000, 'ASK_JOB_TTL_MS'),
    systemPrompt: merged.ASK_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    /** Off by default: questions are spoken out loud and land in a log file. */
    logQuestions: bool(merged.ASK_LOG_QUESTIONS, false),

    claude: {
      bin: (merged.ASK_CLAUDE_BIN || 'claude').trim(),
      /** The directory the CLI runs in. Nothing outside it is in scope. */
      workDir: (merged.ASK_WORK_DIR || process.cwd()).trim(),
      /** Extra read/write roots, comma separated. */
      addDirs: (merged.ASK_ADD_DIRS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      model: (merged.ASK_CLAUDE_MODEL || '').trim(),
      /**
       * Left at "default" deliberately. A headless session cannot answer a
       * permission prompt, so wider modes are the ones people end up choosing,
       * and bypassPermissions on a network-reachable endpoint means the token
       * is the only thing between a stranger and a shell. That is a decision to
       * make on purpose, in a config file, not to inherit from a default.
       */
      permissionMode: (merged.ASK_CLAUDE_PERMISSION_MODE || 'default').trim(),
      allowedTools: (merged.ASK_CLAUDE_ALLOWED_TOOLS || '').trim(),
    },

    http: {
      baseUrl: (merged.ASK_HTTP_BASE_URL || '').trim().replace(/\/+$/, ''),
      apiKey: (merged.ASK_HTTP_API_KEY || '').trim(),
      model: (merged.ASK_HTTP_MODEL || '').trim(),
      maxTokens: int(merged.ASK_HTTP_MAX_TOKENS, 512, 'ASK_HTTP_MAX_TOKENS'),
      temperature: merged.ASK_HTTP_TEMPERATURE === undefined || merged.ASK_HTTP_TEMPERATURE === ''
        ? undefined
        : Number(merged.ASK_HTTP_TEMPERATURE),
    },
  };

  if (!config.token) {
    throw new Error(
      'ASK_TOKEN is not set. The server refuses to start without one: it listens ' +
        'on the network and the token is the whole lock. See .env.example.'
    );
  }
  if (config.token.length < 16) {
    throw new Error('ASK_TOKEN is too short. Use at least 16 characters of random hex.');
  }
  if (config.adapter === 'http' && !config.http.baseUrl) {
    throw new Error('ASK_ADAPTER=http needs ASK_HTTP_BASE_URL.');
  }
  if (config.adapter === 'http' && !config.http.model) {
    throw new Error('ASK_ADAPTER=http needs ASK_HTTP_MODEL.');
  }
  if (
    config.http.temperature !== undefined &&
    Number.isNaN(config.http.temperature)
  ) {
    throw new Error('ASK_HTTP_TEMPERATURE must be a number.');
  }

  return config;
}

module.exports = { loadConfig, parseEnvFile, DEFAULT_SYSTEM_PROMPT };
