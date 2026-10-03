import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright'),browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[],modules=[];
const config=await sealLocalDefault('sk-synthetic-checkpoint-only');await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
await context.route('https://**',r=>{errors.push('Unexpected upstream');return r.abort();});
// Simulate an obsolete cached unversioned engine; release imports must bypass it.
await context.route(/\/src\/engine\.js$/,r=>r.fulfill({body:'throw Error("Stale engine reused")',contentType:'text/javascript'}));
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/\/src\/.*\.js/.test(r.url()))modules.push(r.url());});
try{
 await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 const result=await page.evaluate(async()=>{
  const {Runner,Transport}=await import('./src/engine.js'),{makeProject,newJob,sha256}=await import('./src/core.js'),s=await import('./src/storage.js'),cp=await import('./src/download-checkpoint.js');
  const fixture=await(await fetch('./tests/fixtures/synthetic.mp4')).blob(),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('receipt-fixture',{create:true}),p=makeProject();
  const j=newJob({id:'S03',episode:'EP01',prompt:'4秒测试',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});j.state='download';j.attempts=[{number:1,videoId:'original-id',url:'https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4',requestHash:'a'.repeat(64),downloadFailures:8,downloadRecovery:true,downloadRetryAt:Date.now()+300000}];p.jobs=[j];
  const a=j.attempts[0],path=cp.rawDownloadPath(j),receipt={...a,rawPath:path,rawSha256:await sha256(fixture),rawBytes:fixture.size,downloadCompleteAt:new Date().toISOString()};
  await s.writeFile(folder,path,fixture);await cp.writeDownloadReceipt(folder,j,receipt);
  // Wrong request ownership and a tampered file must not satisfy recovery.
  a.requestHash='b'.repeat(64);const wrongOwner=await cp.savedDownload(folder,j);a.requestHash=receipt.requestHash;
  await s.writeFile(folder,path,new Blob(['broken']));const broken=await cp.savedDownload(folder,j);await s.writeFile(folder,path,fixture);
  a.discardedDownload={sha256:receipt.rawSha256};const discarded=await cp.savedDownload(folder,j);delete a.discardedDownload;
  const r=new Runner(()=>({project:p,folder}),()=>{},()=>{});let calls=0;r.transport.media=async()=>{calls++;throw Error('Verified original should bypass network');};r.transport.api=async()=>{calls++;throw Error('Must not recreate or requery task');};
  Object.defineProperty(navigator,'onLine',{value:false,configurable:true});const start=Date.now();await r.step(j);await Promise.all(r.localChecks.values());delete navigator.onLine;
  // Each failed path is recorded, without URLs with signatures or credentials.
  const real=fetch,t=new Transport(()=>({project:p}));window.fetch=async()=>{throw new TypeError('Synthetic CORS / network');};let error;
  try{await t.media(a.url);}catch(e){error=e;}finally{window.fetch=real;}
  return {version:document.documentElement.dataset.runtimeVersion,wrongOwner:wrongOwner===null,broken:broken===null,discarded:discarded===null,calls,state:j.state,error:j.error,decode:j.current?.qa.fullDecode,videoId:a.videoId,attempts:j.attempts.length,elapsed:Date.now()-start,diagnostic:error?.diagnostic,receipt:JSON.parse(await(await s.readFile(folder,path+'.json')).text())};
 });
 assert.equal(result.state,'ready',result.error);assert.equal(result.decode,'passed');assert.equal(result.calls,0);assert.equal(result.videoId,'original-id');assert.equal(result.attempts,1);assert.ok(result.elapsed<60000);assert.ok(result.wrongOwner&&result.broken&&result.discarded);
 assert.deepEqual(result.diagnostic.channels.map(x=>x.channel),['local','direct','local','direct','local','direct']);assert.equal(result.diagnostic.version,result.version);assert.equal(result.diagnostic.localEligible,true);assert.equal(result.receipt.videoId,'original-id');
 assert.ok(modules.some(url=>url.includes('/engine.js?v='+result.version)));assert.ok(modules.every(url=>url.includes('?v='+result.version)));assert.deepEqual(errors,[]);
 await writeFile('test-results/download-checkpoint-v124-results.json',JSON.stringify({passed:5,result,modules,errors},null,2));console.log(JSON.stringify({passed:5,state:result.state,calls:result.calls,elapsed:result.elapsed,version:result.version,errors},null,2));
}finally{await browser.close();}
