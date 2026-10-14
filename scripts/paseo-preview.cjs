// Paseo launcher only; all HTTP, market and trading services run in Rust.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const binary = path.join(root, 'server/target/debug', process.platform === 'win32' ? 'trading-service.exe' : 'trading-service');
const portText = process.env.PASEO_PORT || '8471';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw Error('Invalid PASEO_PORT');
if (!fs.existsSync(binary) || !fs.existsSync(path.join(root, 'dist/index.html'))) throw Error('Build the Rust service and React application first; see README.md');
const data = path.join(root, 'var/paseo-preview');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'port'), portText);
// Explicit environment prevents unrelated account credentials entering the preview.
const child = spawn(binary, [], {
  cwd: root,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    TRADING_ROOT: root,
    TRADING_NODE: process.execPath,
    TRADING_DATA_DIR: data,
    TRADING_BIND: `127.0.0.1:${portText}`,
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
