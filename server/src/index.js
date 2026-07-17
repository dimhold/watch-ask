'use strict';

const { loadConfig } = require('./config');
const { createAdapter } = require('./adapters');
const { createServer } = require('./server');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`config: ${e.message}`);
    process.exit(1);
  }

  let adapter;
  try {
    adapter = createAdapter(config);
  } catch (e) {
    console.error(`adapter: ${e.message}`);
    process.exit(1);
  }

  const { server } = createServer(config, adapter);

  server.listen(config.port, config.host, () => {
    console.log(`watch-ask listening on ${config.host}:${config.port}`);
    console.log(`adapter: ${adapter.name}`);
    if (adapter.name === 'claude-cli') {
      console.log(`work dir: ${config.claude.workDir}`);
      console.log(`permission mode: ${config.claude.permissionMode}`);
    }
    if (config.host === '0.0.0.0') {
      console.log('reachable from the LAN. The token is the only lock on it.');
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`port ${config.port} is already taken. Set ASK_PORT.`);
      process.exit(1);
    }
    throw e;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

if (require.main === module) main();

module.exports = { main };
