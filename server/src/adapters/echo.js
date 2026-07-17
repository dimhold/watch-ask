'use strict';

/**
 * Answers without an LLM. Not a toy: it is how you tell a broken watch, a
 * blocked port or a wrong token apart from a backend that is merely slow.
 *
 * Run the server with ASK_ADAPTER=echo, press the button, and if the watch
 * reads your own question back then the network half is fine and the problem
 * is downstream.
 */
function createEchoAdapter() {
  async function ask(question) {
    return { reply: `You said: ${question}` };
  }
  return { name: 'echo', ask };
}

module.exports = { createEchoAdapter };
