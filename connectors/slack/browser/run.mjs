import { createInterface } from 'node:readline';
import { sanitizeAggregate } from './probe.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const mode = process.argv[2];
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let runtime;
let child;
let interrupted = false;
let input;

async function main() {
  if (process.argv.length !== 7 || process.argv[3] !== '--playwright' || process.argv[5] !== '--browsers' || !path.isAbsolute(process.argv[4]) || !path.isAbsolute(process.argv[6]) || !['smoke', 'owner-login'].includes(mode)) {
    emit({ valid_arguments: false });
    process.exitCode = 2;
    return;
  }
  process.umask(0o077);
  await mkdir(path.join(root, '.runtime'), { recursive: true, mode: 0o700 });
  runtime = await mkdtemp(path.join(root, '.runtime', 'run-'));
  await mkdir(path.join(runtime, 'home'), { mode: 0o700 });
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(runtime, 'home'),
    TMPDIR: runtime,
    PLAYWRIGHT_BROWSERS_PATH: process.argv[6],
  };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  child = spawn(process.execPath, [path.join(root, 'worker.mjs'), mode, process.argv[4]], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.on('message', (message) => {
    if (message === true) emit({ browser_ready: true, owner_login_required: mode === 'owner-login' });
    else if (message === false) emit({ probe_failed: true });
    else {
      const aggregate = sanitizeAggregate(message);
      if (aggregate) emit(aggregate);
      else emit({ probe_failed: true });
    }
  });
  if (mode === 'owner-login') {
    input = createInterface({ input: process.stdin, terminal: false });
    input.on('line', (line) => {
      if (line === 'p' && child.connected) child.send('probe', () => {});
      else if (line === 'q') child.kill('SIGTERM');
      else emit({ valid_command: false });
    });
  }
  const stop = () => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (value) => resolve(value ?? 1));
  });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  emit({ completed: code === 0, interrupted });
  process.exitCode = code === 0 ? 0 : 1;
}

try {
  await main();
} catch {
  emit({ completed: false });
  process.exitCode = 1;
} finally {
  input?.close();
  if (runtime) {
    try {
      await rm(runtime, { recursive: true, force: true });
      emit({ runtime_removed: true });
    } catch {
      emit({ runtime_removed: false });
      process.exitCode = 1;
    }
  }
}
