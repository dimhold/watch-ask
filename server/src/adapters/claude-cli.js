'use strict';

const { spawn } = require('child_process');

/**
 * Answers by running the Claude Code CLI in headless mode on this machine.
 *
 * This is the $0-in-API adapter: `claude -p` is you using your own Claude
 * subscription on your own machine, the same as typing in the terminal. It is
 * not the Agent SDK, which bills per token against an API key.
 *
 * Every call is a fresh session. No --resume, no session file, no transcript on
 * disk. The watch asks a question and gets an answer, and the next question
 * knows nothing about this one.
 */
function createClaudeCliAdapter(config, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const { bin, workDir, addDirs, model, permissionMode, allowedTools } = config.claude;

  /** Exposed so the argument shape can be asserted without running anything. */
  function buildArgs() {
    const args = ['-p', '--output-format', 'json'];
    if (config.systemPrompt) args.push('--append-system-prompt', config.systemPrompt);
    if (model) args.push('--model', model);
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (allowedTools) args.push('--allowed-tools', allowedTools);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return args;
  }

  /**
   * The CLI's JSON envelope, not its stdout text. An API failure comes back
   * with exit code 0, an empty stderr and the reason buried in this object, so
   * reading stdout is the only way to tell a rate limit from a silent success.
   */
  function readEnvelope(stdout) {
    const parsed = JSON.parse(stdout);
    if (parsed.is_error) {
      throw new Error(`claude reported an error: ${String(parsed.result).slice(0, 400)}`);
    }
    const reply = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    if (!reply) throw new Error('claude returned an empty result');
    return { reply, costUsd: parsed.total_cost_usd };
  }

  function ask(question) {
    return new Promise((resolve, reject) => {
      const args = buildArgs();

      // shell: false and the question over stdin, never as an argument. What
      // arrives here was dictated into a watch by whoever holds the token, and
      // an argument is one quoting bug away from being a command.
      const child = spawnFn(bin, args, {
        cwd: workDir,
        shell: false,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(reject, new Error(`claude timed out after ${config.timeoutMs}ms`));
      }, config.timeoutMs);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => {
        const hint =
          e.code === 'ENOENT'
            ? ` (is "${bin}" on PATH? set ASK_CLAUDE_BIN to its full path)`
            : '';
        finish(reject, new Error(`could not run claude: ${e.message}${hint}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          return finish(
            reject,
            new Error(`claude exited ${code}: ${stderr.slice(0, 400) || '(no stderr)'}`)
          );
        }
        try {
          finish(resolve, readEnvelope(stdout));
        } catch (e) {
          finish(reject, new Error(`${e.message} [stdout: ${stdout.slice(0, 200)}]`));
        }
      });

      child.stdin.on('error', () => {});
      child.stdin.write(question);
      child.stdin.end();
    });
  }

  return { name: 'claude-cli', ask, buildArgs, readEnvelope };
}

module.exports = { createClaudeCliAdapter };
