import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const source=process.env.XAI_MEDIA_TEST_FILE||'tests/fixtures/synthetic.mp4',bytes=await readFile(source),mode=process.env.XAI_METADATA_TEST_MODE||'timeout';
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
const config=await sealLocalDefault('sk-synthetic-metadata-recovery');
await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
await context.route('https://**',r=>r.abort());
await context.route('**/__metadata-original.mp4',r=>r.fulfill({body:bytes,contentType:'video/mp4'}));
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 const result=await page.evaluate(async mode=>{
  const {Runner}=await import('./src/engine.js'),{QueueWatchdog}=await import('./src/queue-watchdog.js'),{makeProject,newJob,sha256,validateProjectFile}=await import('./src/core.js'),s=await import('./src/storage.js');
  const original=await(await fetch('./__metadata-original.mp4')).blob(),hash=await sha256(original),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('isolated-S11-metadata',{create:true});
  // Isolated OPFS only: no user's folder or credentials are accessed.
  Object.getPrototypeOf(folder).queryPermission=async()=> 'granted';
  const p=makeProject(),j=newJob({id:'S11',episode:'EP01',prompt:'12秒，南京夫子庙国庆节人山人海',seconds:12,aspect:'9:16',mode:'text',assetIds:[]});p.jobs=[j];
  const a={number:1,videoId:'original_S11_fixture',url:'https://synthetic.invalid/original.mp4',requestHash:'b'.repeat(64)};j.attempts=[a];
  const phases=[],r=new Runner(()=>({project:p,folder}),()=>{},()=>{});r.onActivity=()=>phases.push(r.localActivity.label);let network=0;
  r.transport.key='';r.transport.api=r.transport.media=async()=>{network++;throw Error('Saved original must recover without network or generation');};
  await r.saveDownloaded(j,original,a);j.state='blocked';j.error='无法读取媒体信息，请转换为常见格式后导入。';a.lastProblem={operation:'local',code:'Error',message:j.error};await r.persist(true);
  // Reproduce both native metadata waits expiring, without accelerating timers.
  const create=document.createElement.bind(document);let injected=0;
  document.createElement=function(tag,...args){const el=create(tag,...args);if(tag==='video'&&injected<(mode==='incompatible'?4:2)){injected++;Object.defineProperty(el,'duration',{get:()=>NaN});if(mode==='incompatible'){const load=el.load.bind(el);el.load=()=>{load();if(el.hasAttribute('src'))setTimeout(()=>el.dispatchEvent(new Event('error')),200);};}}return el;};
  const began=Date.now(),w=new QueueWatchdog(()=>({project:p,runner:r,folder}));
  try{await w.tick();while(r.running||r.starting){if(Date.now()-began>120000)throw Error('Recovery exceeded its bounded deadline: '+j.state+' '+JSON.stringify(a.lastProblem));await new Promise(resolve=>setTimeout(resolve,50));}}finally{document.createElement=create;}
  if(!a.path)throw Error('No playable output: '+JSON.stringify({state:j.state,error:j.error,health:r.health,problem:a.lastProblem,phases:[...new Set(phases)]}));
  const raw=await s.readFile(folder,a.rawPath),clip=await s.readFile(folder,a.path),disk=JSON.parse(await(await s.readFile(folder,'project.json')).text());validateProjectFile(disk);
  const elapsedMs=Date.now()-began;
  const repeated=newJob({id:'S11_REPEAT',episode:'EP01',seconds:12,aspect:'9:16',mode:'text',assetIds:[],prompt:'12秒'}),repeatAttempt={number:1,videoId:'repeat_fixture',rawSha256:hash,sha256:a.sha256};repeated.attempts=[repeatAttempt];
  const repeatProject=makeProject();repeatProject.jobs=[repeated];const repeatRunner=new Runner(()=>({project:repeatProject,folder}),()=>{},()=>{});await repeatRunner.saveDownloaded(repeated,original,repeatAttempt);
  return {elapsedMs,injected,network,state:j.state,review:j.review,attempts:j.attempts.length,videoId:a.videoId,rawHash:await sha256(raw),originalHash:hash,clipHash:await sha256(clip),recordedClipHash:a.sha256,rawBytes:raw.size,clipBytes:clip.size,source:a.playbackSource,qa:a.qa,phases,storedState:disk.jobs[0].state,report:JSON.parse(await(await s.readFile(folder,'checks/S11_v1/report.json')).text()),sameOriginalHasNoNewDownload:!repeatAttempt.downloadSequence&&!repeatAttempt.downloadHistory};
 },mode);
 assert.equal(result.injected,mode==='incompatible'?4:2);assert.ok(result.elapsedMs<120000);if(mode==='timeout')assert.ok(result.elapsedMs>=30000);
 assert.equal(result.state,'ready');assert.equal(result.storedState,'ready');assert.equal(result.review,'pending');
 assert.equal(result.network,0);assert.equal(result.attempts,1);assert.equal(result.videoId,'original_S11_fixture');
 assert.equal(result.rawHash,result.originalHash);assert.equal(result.rawBytes,bytes.length);
 assert.equal(result.sameOriginalHasNoNewDownload,true);
 const transform=mode==='incompatible'?'h264-aac':'remux';
 assert.equal(result.clipHash,result.recordedClipHash);assert.equal(result.source.sha256,result.rawHash);assert.equal(result.source.transform,transform);
 assert.equal(result.qa.fullDecode,'passed');assert.equal(result.qa.technical,'passed');assert.deepEqual(result.qa.fatal,[]);assert.equal(result.report.normalization,transform);assert.deepEqual(errors,[]);
 await writeFile(`test-results/metadata-${mode}-v129-results.json`,JSON.stringify({...result,mode,errors},null,2));
 console.log(JSON.stringify({...result,phases:[...new Set(result.phases)],errors},null,2));
}finally{await browser.close();}
