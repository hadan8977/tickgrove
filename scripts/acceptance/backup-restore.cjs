const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),source=path.resolve(process.env.TRADING_TEST_DATA_DIR||path.join(root,'var/ui-real-data-review'));
const sourceUrl=process.env.TRADING_URL||'http://127.0.0.1:18879',targetUrl='http://127.0.0.1:18880',stamp=Date.now();
const backup=path.join(root,`var/backup-review-${stamp}`),restored=path.join(root,`var/restored-review-${stamp}`);
const env={PATH:process.env.PATH,TRADING_ROOT:root,TRADING_NODE:process.execPath};
const cli=path.join(root,'server/target/debug/trading-cli'),admin=path.join(root,'server/target/debug/trading-admin');
const call=(url,dir,method,params={},key)=>JSON.parse(execFileSync(cli,[method,JSON.stringify(params),...(key?['--key',key]:[])],{cwd:root,env:{...env,TRADING_URL:url,TRADING_TOKEN_FILE:path.join(dir,'auth-token')},encoding:'utf8'}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const before=call(sourceUrl,source,'account.state');
 const jobs=call(sourceUrl,source,'backtest.status').filter(j=>j.status==='succeeded');assert.ok(jobs.length,'Run the real-workspace acceptance first');
 const result=JSON.parse(execFileSync(admin,['backup','--data-dir',source,'--output',backup],{env,encoding:'utf8'}));assert.equal(result.ok,true);assert.equal(fs.statSync(path.join(backup,'auth-token')).mode&0o777,0o600);
 execFileSync(admin,['restore','--input',backup,'--data-dir',restored],{env,encoding:'utf8'});
 assert.throws(()=>execFileSync(admin,['restore','--input',backup,'--data-dir',source],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),/Destination must be/);
 const child=spawn(path.join(root,'server/target/debug/trading-service'),[],{cwd:root,env:{...env,TRADING_DATA_DIR:restored,TRADING_BIND:'127.0.0.1:18880'},stdio:['ignore','ignore','pipe']});
 let logs='';child.stderr.on('data',data=>{logs+=data});
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(targetUrl+'/health')).ok;if(ready)break}catch{}await delay(100)}assert.ok(ready,logs);
  const after=call(targetUrl,restored,'account.state');assert.equal(after.cash,before.cash);assert.deepEqual(after.fills,before.fills);
  const existing=call(targetUrl,restored,'backtest.results',{job_id:jobs[0].job_id});assert.equal(existing.status,'succeeded');
  const submitted=call(targetUrl,restored,'backtest.start',{version_id:existing.manifest.version_id,snapshot_id:existing.manifest.snapshot_id,inputs:existing.manifest.inputs},`backup-audit-${stamp}`);
  let final;for(let i=0;i<100;i++){final=call(targetUrl,restored,'backtest.results',{job_id:submitted.job_id});if(!['queued','running'].includes(final.status))break;await delay(300)}assert.equal(final.status,'succeeded',final.error);
  const output={at:new Date().toISOString(),runtime:'Rust trading-admin + trading-cli',checks:['online consistent SQLite backup','private token mode 0600','checksum and integrity-checked restore','nonempty destination refuses overwrite','cash and fills survive independent service startup','saved report restored','new native job executes after restore'],databaseSha256:result.databaseSha256,restoredJob:final.job_id,sourceJob:existing.job_id};
  fs.writeFileSync(path.join(root,'docs/acceptance/backup-restore.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output));
 }finally{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL')}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
