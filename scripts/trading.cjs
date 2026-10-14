#!/usr/bin/env node
// Tickgrove authenticated compatibility CLI shares the Web/MCP command endpoint.
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args[0]) { console.error('Usage: tickgrove METHOD [PARAMS.json | JSON] [--key IDEMPOTENCY_KEY] (or node scripts/trading.cjs METHOD [PARAMS.json | JSON] [--key IDEMPOTENCY_KEY])'); process.exit(2); }
let params = {};
try {
  if (args[1] && !args[1].startsWith('--')) params = JSON.parse(fs.existsSync(args[1]) ? fs.readFileSync(args[1], 'utf8') : args[1]);
  const token = (process.env.TICKGROVE_TOKEN ?? process.env.TRADING_TOKEN ?? fs.readFileSync(process.env.TICKGROVE_TOKEN_FILE ?? process.env.TRADING_TOKEN_FILE ?? 'var/auth-token', 'utf8')).trim();
  if (token.length < 24) throw Error('Instance token is missing or invalid');
  const key = args.indexOf('--key');
  fetch((process.env.TICKGROVE_URL ?? process.env.TRADING_URL ?? 'http://127.0.0.1:8787') + '/api/command', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ method: args[0], params, idempotency_key: key >= 0 ? args[key + 1] : undefined }),
  }).then(async response => { const data = await response.json(); console.log(JSON.stringify(data, null, 2)); process.exitCode = response.ok ? 0 : 1; }).catch(e => { console.error(e.message); process.exitCode = 1; });
} catch (e) { console.error(e.message); process.exitCode = 2; }
