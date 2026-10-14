// Single-request worker. Protocol stdout only; invoked with bounded V8 heap by Rust.
require('./register-typescript.cjs');
const { runPine } = require('../src/pine/runtime.ts');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 16_000_000) process.exit(2); });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input);
    const data = request.data;
    if(request.operation === "dependencies") {process.stdout.write(JSON.stringify({ok:true,...require("../src/pine/library.ts").pineDependencies(request.source,request.libraryLock)}));return;}
    if (request.continuous && request.kind === 'pine') {
      const {Indicator} = require('pinets');
      const linked=require("../src/pine/library.ts").linkPineLibraries(request.source,request.libraryLock);
      const declaration = new Indicator(linked.source, request.inputs);
      if (declaration.getDeclarationType() !== "strategy") throw Error("Continuous Pine requires strategy(), indicators are analysis-only");
      if (declaration.prop.calc_on_every_tick === true || declaration.prop.calc_on_order_fills === true) throw Error('Continuous closed-bar mode rejects tick/fill recalculation');
      const code = require('../src/pine/runtime.ts').codeWithoutComments(linked.source).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,'');
      if (/\bbarstate\s*\.\s*(?:islast|isrealtime|islastconfirmedhistory)\b|\blookahead_on\b|\bvarip\b/.test(code)) throw Error('Continuous closed-bar mode rejects repainting, lookahead_on and varip constructs');
    }
    const result = request.kind === "composer" ? require("../src/composer/engine.ts").runComposer(JSON.parse(request.source), data) : await runPine(request.source, data.bars, data.timeframe, {
      symbol: data.symbol, metadata: data.metadata, datasets: data.datasets,
      inputs: request.inputs, backtest: true, libraryLock:request.libraryLock,
    });
    process.stdout.write(JSON.stringify(result, (_, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: error.message } }));
    process.exitCode = 1;
  }
});
