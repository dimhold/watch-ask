'use strict';

/**
 * Asks the running server a question from the terminal, exactly the way the
 * watch does. Use it before you touch the watch at all: if this works and the
 * watch does not, the problem is the network or the token, not the backend.
 *
 *   node src/ask.js "what changed in this repo today?"
 *   ASK_URL=http://192.0.2.10:8787 node src/ask.js "..."
 */

const { loadConfig } = require('./config');

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('usage: node src/ask.js "your question"');
    process.exit(2);
  }

  const config = loadConfig();
  const base = (process.env.ASK_URL || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '');

  const res = await fetch(`${base}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ question }),
  });

  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(`${res.status}: ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${res.status}: ${json.error || raw}`);
    process.exit(1);
  }
  console.log(json.reply);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
