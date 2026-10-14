#!/usr/bin/env node
// node scripts/pine.cjs run script.pine --data bars.json --timeframe 1D --symbol SPY [--backtest]
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
if (!isMainThread) {
  require('./register-typescript.cjs');
  const { runPine } = require('../src/pine/runtime.ts');
  runPine(workerData.source, workerData.bars, workerData.tf, workerData.options)
    .then(result => parentPort.postMessage(result)).catch(error => parentPort.postMessage({ ok: false, error: { message: error.message } }));
} else {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args[0] !== 'run' || !args[1] || !value('--data')) {
    console.error('Usage: node scripts/pine.cjs run script.pine --data bars.json [--symbol SPY] [--timeframe 1D] [--inputs inputs.json] [--backtest]');
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(fs.readFileSync(value('--data'), 'utf8'));
      const data = { source: fs.readFileSync(args[1], 'utf8'), bars: Array.isArray(input) ? input : input.bars,
        tf: value('--timeframe') ?? input.timeframe ?? '1D', options: {
          symbol: value('--symbol') ?? input.symbol, metadata: input.metadata, datasets: input.datasets,
          inputs: value('--inputs') ? JSON.parse(fs.readFileSync(value('--inputs'), 'utf8')) : undefined,
          backtest: args.includes('--backtest'),
        } };
      const worker = new Worker(__filename, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      let settled = false;
      const done = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); worker.terminate();
        console.log(JSON.stringify(result, (_, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
        process.exitCode = result.ok ? 0 : 1;
      };
      const timer = setTimeout(() => done({ ok: false, error: { message: 'Pine run exceeded 30 seconds' } }), 30_000);
      worker.once('message', done);
      worker.once('error', error => done({ ok: false, error: { message: error.message } }));
      worker.once('exit', code => { if (!settled) done({ ok: false, error: { message: 'Pine worker exited ' + code } }); });
    } catch (error) { console.log(JSON.stringify({ ok: false, error: { message: error.message } })); process.exitCode = 2; }
  }
}
