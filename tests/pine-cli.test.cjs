const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('CLI runs a public strategy and returns one machine-readable native report',()=>{
  const result=spawnSync(process.execPath,['scripts/pine.cjs','run','tests/fixtures/pine-public/analyzer-anvil-percent-costs-01.pine','--data','examples/pine/synthetic-spy.json','--backtest'],{cwd:root,encoding:'utf8',timeout:45000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const report=JSON.parse(result.stdout);assert.equal(report.ok,true);
  assert.equal(report.backtest.engine,'pinets');assert.equal(report.backtest.config.capital,100000);
  assert.equal(report.backtest.equity.length,256);assert.ok(report.backtest.trades.length>0);
  assert.equal(report.backtest.nativeConfig.commissionValue,0.08);
});
test('CLI distinguishes invalid invocation and missing input files',()=>{
  const usage=spawnSync(process.execPath,['scripts/pine.cjs'],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(usage.status,2);assert.match(usage.stderr,/Usage/);
  const missing=spawnSync(process.execPath,['scripts/pine.cjs','run','absent.pine','--data','absent.json'],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(missing.status,2);assert.equal(JSON.parse(missing.stdout).ok,false);
});
