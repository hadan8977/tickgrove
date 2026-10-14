// Tickgrove optional authenticated-instance sharing; never starts a second trading service.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const state = path.join(root, 'var/paseo-preview');
  const port = Number(fs.readFileSync(path.join(state, 'port'), 'utf8'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid preview port');
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw Error('Start the Tickgrove preview first');
  const child = spawn('cloudflared', ['tunnel', '--config', process.platform === 'win32' ? 'NUL' : '/dev/null', '--no-autoupdate', '--protocol', 'http2', '--url', origin, '--logfile', path.join(state, 'share.log')], {
    cwd: root,
    stdio: 'inherit',
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(`Sharing launcher: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
