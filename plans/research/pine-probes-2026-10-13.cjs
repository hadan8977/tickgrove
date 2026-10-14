// Research probes only. Run from the repository root:
// node plans/research/pine-probes-2026-10-13.cjs
// These synthetic checks are not TradingView parity tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const { PineTS } = require(path.join(root, 'node_modules/pinets'));
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(
  fs.readFileSync(file, 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText, file);
const { runPine } = require(path.join(root, 'src/pine/runtime.ts'));
const { simulate } = require(path.join(root, 'src/backtest/engine.ts'));
const bars = Array.from({ length: 80 }, (_, i) => ({
  time: 1700000000 + i * 86400,
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000,
}));
const data = bars.map(b => ({ ...b, openTime: b.time * 1000,
  closeTime: (b.time + 86400) * 1000 }));
const probes = [
  { id: 'array', body: 'a = array.new<float>(2, close)\nplot(array.get(a, 0), "value")', expected: 180 },
  { id: 'map', body: 'm = map.new<string, float>()\nmap.put(m, "price", close)\nplot(map.get(m, "price"), "value")', expected: 180 },
  { id: 'matrix', body: 'm = matrix.new<float>(2, 2, close)\nplot(matrix.get(m, 0, 0), "value")', expected: 180 },
  { id: 'udt', body: 'type Point\n    float price\np = Point.new(close)\nplot(p.price, "value")', expected: 180 },
  { id: 'table', body: 'var t = table.new(position.top_right, 1, 1)\nif barstate.islast\n    table.cell(t, 0, 0, "probe")\nplot(close, "value")', expected: 180 },
  { id: 'while', body: 'int i = 0\nfloat n = 0.0\nwhile i < 3\n    n += 1\n    i += 1\nplot(n, "value")', expected: 3 },
];
function summarize(ctx) {
  return {
    plotKeys: Object.keys(ctx.plots ?? {}),
    lastValue: ctx.plots?.value?.data?.at(-1)?.value,
    warnings: ctx.warnings ?? [],
  };
}
(async () => {
  const rows = [];
  for (const p of probes) {
    const source = `//@version=6\nindicator("${p.id}")\n${p.body}`;
    let direct;
    try {
      const runtime = new PineTS(data);
      runtime.setMaxLoops(1000);
      const ctx = await runtime.run(source);
      direct = { ok: true, ...summarize(ctx) };
      direct.expectedValuePass = direct.lastValue === p.expected;
    } catch (e) { direct = { ok: false, error: String(e.message ?? e) }; }
    const wrapped = await runPine(source, bars, '1D');
    rows.push({ id: p.id, source, expected: p.expected, direct,
      projectWrapper: { ok: wrapped.ok, error: wrapped.error ?? null,
        outputSeries: wrapped.plots.map(p => p.title) } });
  }
  const timingSource = `//@version=6\nstrategy("Timing", overlay=true)\nif bar_index == 1\n    strategy.entry("L", strategy.long)\nif bar_index == 4\n    strategy.close("L")`;
  const timingBars = bars.slice(0, 7);
  const result = await runPine(timingSource, timingBars, '1D');
  const timing = result.ok ? {
    pineSignalsExtractedFromFills: result.signals,
    downstreamTrades: simulate(timingBars, result.signals,
      { capital: 10000, commissionBps: 0, slippageBps: 0, sizePct: 95 }, '1D').trades,
  } : { error: result.error };
  const output = {
    checkedAt: new Date().toISOString(), node: process.version,
    pinets: require(path.join(root, 'node_modules/pinets/package.json')).version,
    wrapperSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/pine/runtime.ts'))).digest('hex'),
    limitations: ['Synthetic single-timeframe data only', 'No TradingView oracle',
      'Successful table execution does not verify chart rendering',
      'No external brokerage, market data, or network calls'],
    probes: rows, timing,
  };
  const outputPath = path.join(__dirname, 'pine-probes-2026-10-13.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ outputPath, probes: rows.map(r => ({ id:r.id,
    direct:r.direct.ok, valueCorrect:r.direct.expectedValuePass,
    wrapper:r.projectWrapper.ok })), timing }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
