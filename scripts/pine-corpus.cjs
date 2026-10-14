// Offline execution coverage, NOT a TradingView parity score.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
if (!isMainThread) {
  // Parent compiles the adapter once and freezes it for the entire run. Each
  // script still gets a new, separately bounded worker and PineTS instance.
  require.extensions['.ts'] = (module, filename) => {
    const code = workerData.compiled[filename];
    if (code == null) throw Error('Unexpected TypeScript dependency: ' + filename);
    module._compile(code, filename);
  };
  const {runPine}=require('../src/pine/runtime.ts');
  const minutes=/request\.(security|security_lower_tf)/.test(workerData.source)?15:60;
  const bars=Array.from({length:256},(_,i)=>{
    const price=150+15*Math.sin(i/7)+8*Math.cos(i/19)+i/20;
    return {time:1704067200+i*minutes*60,open:price,high:price+3,low:price-3,close:price+Math.sin(i)*2,volume:1000+(i*7919)%4000};
  });
  const minuteBars=bars.flatMap(b=>Array.from({length:minutes},(_,j)=>{
    const open=b.open+(b.close-b.open)*j/minutes,close=b.open+(b.close-b.open)*(j+1)/minutes;
    return {time:b.time+j*60,open,close,high:j===Math.floor(minutes/3)?b.high:Math.max(open,close),low:j===Math.floor(minutes*2/3)?b.low:Math.min(open,close),volume:b.volume/minutes};
  }));
  runPine(workerData.source,bars,String(minutes),{symbol:'BINANCE:ETHUSDT',metadata:{type:'crypto',timezone:'UTC'},
    datasets:[{symbol:'BINANCE:ETHUSDT',timeframe:'1',bars:minuteBars}],backtest:true,maxLoops:5000})
    .then(r=>parentPort.postMessage({ok:r.ok,error:r.error,warnings:r.warnings,plots:r.plots.length,trades:r.backtest?.trades.length??0,ms:r.ms,
      timeframe:String(minutes),finiteEquity:r.backtest?.equity.every(e=>Number.isFinite(e.value))??false}));
} else {
  const dir=path.join(root,'tests/fixtures/pine-public');
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
  const ts=require('typescript');
  const compiled={},adapterHashes={};
  for(const file of ['src/pine/runtime.ts','src/pine/data.ts','src/pine/report.ts','src/pine/compat.ts','src/pine/library.ts']) {
    const filename=path.join(root,file), source=fs.readFileSync(filename,'utf8');
    adapterHashes[file]=crypto.createHash('sha256').update(source).digest('hex');
    compiled[filename]=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  }
  async function check(entry){
    const source=fs.readFileSync(path.join(dir,entry.file),'utf8');
    if(crypto.createHash('sha256').update(source).digest('hex')!==entry.sha256)throw Error('Fixture hash mismatch: '+entry.file);
    return new Promise(resolve=>{
      const worker=new Worker(__filename,{workerData:{source,compiled},resourceLimits:{maxOldGenerationSizeMb:256}});
      let settled=false;
      const done=r=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate();resolve({file:entry.file,...r})};
      const timer=setTimeout(()=>done({ok:false,error:{message:'5 second execution deadline'}}),5000);
      worker.once('message',done);worker.once('error',e=>done({ok:false,error:{message:e.message}}));
      worker.once('exit',code=>{if(!settled)done({ok:false,error:{message:'Worker exited '+code}})});
    });
  }
  (async()=>{
    const selected=process.argv[2] ? manifest.scripts.filter(e=>e.file.includes(process.argv[2])) : manifest.scripts;
    if (!selected.length) throw Error('No public fixture matched ' + process.argv[2]);
    const results=[];
    for(const entry of selected){results.push(await check(entry));if(results.length%25===0)console.log(`${results.length}/${selected.length}: ${results.filter(r=>r.ok).length} executed`);}
    const report={checkedAt:new Date().toISOString(),pinets:require('../node_modules/pinets/package.json').version,sourceCommit:manifest.commit,adapterHashes,
      test:'Unmodified public source on 256 deterministic synthetic bars (15m for request scripts, 60m otherwise), with a consistent synthetic 1m tape',
      limitations:['Execution coverage only; not TradingView equivalence','No browser rendering assertion','No real brokerage','Missing datasets remain explicit failures'],
      total:results.length,passed:results.filter(r=>r.ok&&r.finiteEquity).length,
      withWarnings:results.filter(r=>r.ok&&r.warnings?.length).length,withClosedTrades:results.filter(r=>r.ok&&r.trades>0).length,results};
    const out=process.env.PINE_CORPUS_REPORT ? path.resolve(root,process.env.PINE_CORPUS_REPORT) : path.join(root,'plans/research/pine-public-execution'+(process.argv[2]?'-filtered':'')+'.json');
    fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({report:out,total:report.total,passed:report.passed,failures:results.filter(r=>!r.ok||!r.finiteEquity).map(r=>({file:r.file,error:r.error?.message}))},null,2));
    process.exitCode=report.passed===report.total?0:1;
  })().catch(e=>{console.error(e);process.exitCode=1});
}
