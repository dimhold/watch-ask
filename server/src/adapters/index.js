'use strict';

const { createClaudeCliAdapter } = require('./claude-cli');
const { createHttpLlmAdapter } = require('./http-llm');
const { createEchoAdapter } = require('./echo');

/**
 * An adapter is one function: ask(question) -> Promise<{ reply }>.
 *
 * That is the whole contract. To bolt on a backend this project has never
 * heard of, write the function, add it here, and the watch never learns the
 * difference.
 */
const ADAPTERS = {
  'claude-cli': createClaudeCliAdapter,
  http: createHttpLlmAdapter,
  echo: createEchoAdapter,
};

function createAdapter(config, deps = {}) {
  const factory = ADAPTERS[config.adapter];
  if (!factory) {
    throw new Error(
      `unknown ASK_ADAPTER "${config.adapter}". Known: ${Object.keys(ADAPTERS).join(', ')}`
    );
  }
  return factory(config, deps);
}

module.exports = { createAdapter, ADAPTERS };
