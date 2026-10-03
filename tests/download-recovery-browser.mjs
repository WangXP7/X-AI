import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
const config=await sealLocalDefault('sk-synthetic-download-only');
await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
await context.route('https://**',r=>{errors.push('Unexpected real upstream request');return r.abort();});page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 const results=await page.evaluate(async()=>{
  const {Transport,Runner}=await import('./src/engine.js'),{recoverDownloads}=await import('./src/download-recovery.js'),{makeProject,newJob}=await import('./src/core.js'),s=await import('./src/storage.js');
  const original=fetch,fixture=await(await original('./tests/fixtures/synthetic.mp4')).arrayBuffer(),p=makeProject(),transport=new Transport(()=>({project:p}));let local=0,direct=0;
  window.fetch=async(url)=>{
   if(String(url).includes('__xai_media')){local++;if(local===1)return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(fixture.slice(0,32)));controller.error(new TypeError('Synthetic body interruption'));}}),{headers:{'Content-Type':'video/mp4','Content-Length':String(fixture.byteLength)}});return new Response(fixture,{headers:{'Content-Type':'video/mp4','Content-Length':String(fixture.byteLength)}});}
   if(String(url).startsWith('https://')){direct++;throw new TypeError('Synthetic CORS block');}return original(url);
  };
  const recovered=await transport.media('https://cos-platform-outputs.agnes-ai.cn/videos/old.mp4');
  const hash=await(await import('./src/core.js')).sha256(recovered),sourceHash=await(await import('./src/core.js')).sha256(new Blob([fixture]));
  const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('auto-download-tests',{create:true});
  const job=newJob({id:'S02',episode:'EP01',prompt:'4秒测试',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});job.state='blocked';job.error='旧跨域错误';job.attempts=[{number:1,videoId:'unchanged-original-id',url:'https://cos-platform-outputs.agnes-ai.cn/videos/expired.mp4',pollResponse:{status:'completed'},lastProblem:{operation:'media'}}];p.jobs=[job];recoverDownloads(p);
  const runner=new Runner(()=>({project:p,folder}),()=>{},()=>{});runner.transport.key='synthetic';let mediaCalls=0,queries=0,posts=0;
  const {ConnectionError}=await import('./src/network.js');runner.transport.media=async url=>{mediaCalls++;if(url.includes('expired'))throw new ConnectionError('media','local',{status:403});return new Blob([fixture],{type:'video/mp4'});};
  runner.transport.api=async(route,payload)=>{if(payload){posts++;throw Error('Recovery must never POST');}queries++;if(!route.includes('unchanged-original-id'))throw Error('Lost original ID');return {status:'completed',url:'https://cos-platform-outputs.agnes-ai.cn/videos/refreshed.mp4'};};
  await runner.step(job);const waiting={state:job.state,error:job.error,recovery:job.attempts[0].downloadRecovery,queries};await runner.start({onlyUids:[]});
  const transient=newJob({id:'S03',episode:'EP01',prompt:'4秒',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});transient.state='download';transient.attempts=[{number:1,url:'https://cos-platform-outputs.agnes-ai.cn/videos/network.mp4'}];p.jobs.push(transient);runner.transport.media=async()=>{throw new ConnectionError('media','local',new TypeError('offline'));};await runner.step(transient);const checkpoint=await s.get('state','project');
  window.fetch=original;
  return {local,direct,hash,sourceHash,waiting,mediaCalls,queries,posts,state:job.state,fullDecode:job.current?.qa.fullDecode,attempts:job.attempts.length,videoId:job.attempts[0].videoId,retryState:checkpoint.jobs[1].state,retryAt:checkpoint.jobs[1].attempts[0].downloadRetryAt,retryError:checkpoint.jobs[1].error};
 });
 assert.equal(results.local,2);assert.equal(results.direct,1);assert.equal(results.hash,results.sourceHash);assert.equal(results.waiting.state,'download');assert.equal(results.waiting.error,null);assert.equal(results.queries,1);assert.equal(results.posts,0);assert.equal(results.state,'ready');assert.equal(results.fullDecode,'passed');assert.equal(results.attempts,1);assert.equal(results.videoId,'unchanged-original-id');assert.equal(results.retryState,'download');assert.ok(results.retryAt>Date.now());assert.equal(results.retryError,null);assert.deepEqual(errors,[]);
 await writeFile('test-results/download-recovery-v122-results.json',JSON.stringify({checks:['partial body and CORS failure recover automatically from byte zero with matching SHA','expired URL refreshes original task by GET and reaches ready without a new POST','transient failure persists retry checkpoint without requiring user action'],results,errors},null,2));console.log(JSON.stringify({passed:3,results,errors},null,2));
}finally{await browser.close();}
