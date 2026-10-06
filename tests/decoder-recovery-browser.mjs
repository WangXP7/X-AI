import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {sealLocalDefault} from '../src/local-default.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright');
const root=resolve('.'),base='https://wangxp7.github.io/X-AI/',source=process.env.XAI_MEDIA_TEST_FILE||'tests/fixtures/synthetic.mp4',fixture=await readFile(source);
const secrets=await sealLocalDefault('sk-synthetic-cold-decoder-no-upstream'),reports=[],errors=[],external=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
async function routes(context,{fault,blockEngine=false,failures=1}={}){
  const requests={core:[],wasm:[],worker:[]};
  await context.route('**/*',async r=>{
    const u=new URL(r.request().url());
    if(u.origin!==new URL(base).origin){external.push(r.request().url());return r.abort();}
    const path=decodeURIComponent(u.pathname).replace(/^\/X-AI\//,'')||'index.html';
    if(path==='private/default-access.json')return r.fulfill({json:secrets});
    if(path==='__fixture.mp4')return r.fulfill({body:fixture,contentType:'video/mp4'});
    const kind=path.endsWith('ffmpeg-core.wasm')?'wasm':path.endsWith('ffmpeg-core.js')?'core':path==='src/decoder-worker.js'?'worker':null;
    if(kind){requests[kind].push(u.href);if(blockEngine&&kind!=='worker')return r.abort();
      if(fault===kind&&requests[kind].length<=failures)return kind==='worker'?r.fulfill({body:'throw Error("synthetic worker start failure");',contentType:'text/javascript'}):kind==='wasm'?r.fulfill({body:Buffer.from('incomplete wasm'),contentType:'application/wasm'}):r.fulfill({status:503,body:'temporary outage'});
    }
    const file=resolve(root,path);if(!file.startsWith(root+sep)||path.startsWith('private/')||path.startsWith('.'))return r.fulfill({status:404});
    const types={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',wasm:'application/wasm'};
    try{return r.fulfill({body:await readFile(file),contentType:types[file.split('.').at(-1)]||'application/octet-stream'});}catch{return r.fulfill({status:404});}
  });return requests;
}
async function ready(context){const page=context.pages()[0]||await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');return page;}
try{
  const legacy=await browser.newContext();await routes(legacy);let legacyRequests=0;
  await legacy.route('**/vendor/ffmpeg/index.js',r=>++legacyRequests===1?r.abort():r.continue());const legacyPage=await ready(legacy);
  const sticky=await legacyPage.evaluate(async()=>{const errors=[];for(let i=0;i<2;i++){try{await import('./vendor/ffmpeg/index.js');errors.push(null);}catch(e){errors.push(e.message);}}return errors;});
  assert.equal(legacyRequests,1);assert.ok(sticky.every(e=>/Failed to fetch dynamically imported module/.test(e)));reports.push({legacyFailedModule:{errors:sticky,requests:legacyRequests}});await legacy.close();
  for(const fault of ['core','wasm','worker']){
    const context=await browser.newContext(),requests=await routes(context,{fault}),page=await ready(context);
    const report=await page.evaluate(async()=>{const {deepCheck}=await import('./src/media.js'),file=await(await fetch('./__fixture.mp4')).blob(),start=Date.now(),phases=[];const result=await deepCheck(file,p=>{if(phases.at(-1)!==p.label)phases.push(p.label);});return {origin:location.origin,elapsedMs:Date.now()-start,result,phases};});
    assert.equal(report.result.fullDecode,'passed');assert.equal(requests[fault].length,2);assert.notEqual(...requests[fault]);assert.ok(report.elapsedMs<30000,'reported startup error must not wait for timeout');assert.ok(report.phases.some(x=>/自动重建/.test(x)));reports.push({fault,...report,requests});await context.close();
  }
  // Cache storage is optional: failure to cache must not make the engine unusable.
  const noCache=await browser.newContext();await noCache.addInitScript(()=>{Object.defineProperty(window,'caches',{get(){throw new DOMException('cache disabled','SecurityError');}});});await routes(noCache);const noCachePage=await ready(noCache);
  assert.equal(await noCachePage.evaluate(async()=>{const {deepCheck}=await import('./src/media.js');return(await deepCheck(await(await fetch('./__fixture.mp4')).blob())).fullDecode;}),'passed');reports.push({cacheDisabled:'passed'});await noCache.close();
  const outage=await browser.newContext(),outageRequests=await routes(outage,{fault:'core',failures:2}),outagePage=await ready(outage);
  const resumed=await outagePage.evaluate(async()=>{
    const {Runner}=await import('./src/engine.js'),{makeProject,newJob}=await import('./src/core.js'),{videoMetadata}=await import('./src/media.js'),s=await import('./src/storage.js');
    const p=makeProject(),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('temporary-decoder-outage',{create:true});FileSystemDirectoryHandle.prototype.queryPermission=async()=> 'granted';
    const raw=await(await fetch('./__fixture.mp4')).blob(),info=await videoMetadata(raw),aspect=info.width>info.height?'16:9':'9:16',r=new Runner(()=>({project:p,folder}),()=>{},()=>{}),start=Date.now();let upstream=0;r.transport.key='';r.transport.api=r.transport.media=async()=>{upstream++;throw Error('Original already saved');};
    for(let i=0;i<3;i++){const j=newJob({id:'O0'+i,episode:'EP01',prompt:'恢复原片',seconds:12,aspect,mode:'text',assetIds:[]});j.attempts=[{number:1,videoId:'original-outage-'+i,requestHash:'a'.repeat(64)}];p.jobs.push(j);await r.saveDownloaded(j,raw);}
    await r.start({automatic:true,onlyUids:[]});
    return {elapsedMs:Date.now()-start,upstream,jobs:p.jobs.map(j=>({state:j.state,attempts:j.attempts.length,failures:j.current?.localCheckFailures,fullDecode:j.current?.qa?.fullDecode,diagnostics:j.current?.localCheckErrors})),events:p.events.filter(e=>e.kind==='background_check_recovery')};
  });
  assert.equal(outageRequests.core.length,3);assert.ok(resumed.elapsedMs>=30000&&resumed.elapsedMs<90000);assert.equal(resumed.upstream,0);assert.ok(resumed.jobs.every(j=>j.state==='ready'&&j.attempts===1&&j.fullDecode==='passed'&&j.failures===1&&j.diagnostics.length===1&&j.diagnostics[0].code==='http-503-core'));reports.push({sharedOutageRecovery:resumed,requests:outageRequests});await outage.close();
}finally{await browser.close();}

// Shut down the entire isolated browser, retaining OPFS, IndexedDB and cache.
// Relaunch without ChatGPT, restoring three original jobs and blocking engine
// downloads. No real generation API, user profile, or production file is changed.
const profile=await mkdtemp(resolve('test-results/decoder-cold-profile-'));
async function persistent(blockEngine){const c=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true});await c.addInitScript(()=>{FileSystemDirectoryHandle.prototype.queryPermission=async()=> 'granted';});const requests=await routes(c,{blockEngine});return {c,requests,page:await ready(c)};}
let active;
try{
  active=await persistent(false);
  const before=await active.page.evaluate(async()=>{
    const {deepCheck,videoMetadata}=await import('./src/media.js'),{Runner}=await import('./src/engine.js'),{makeProject,newJob}=await import('./src/core.js'),s=await import('./src/storage.js');
    const raw=await(await fetch('./__fixture.mp4')).blob(),info=await videoMetadata(raw),aspect=info.width>info.height?'16:9':'9:16';await deepCheck(raw);
    const p=makeProject(),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('cold-restart',{create:true});
    for(let i=0;i<3;i++){const j=newJob({id:'R0'+(i+1),episode:'EP01',prompt:'已有原片恢复',seconds:12,aspect,mode:'text',assetIds:[]});j.uid='cold-'+i;j.attempts=[{number:1,videoId:'existing-'+i,requestHash:String(i).repeat(64)}];p.jobs.push(j);const r=new Runner(()=>({project:p,folder}),()=>{},()=>{});await r.saveDownloaded(j,raw,j.attempts[0]);}
    await s.put('handles','directory',folder);await s.saveProject(p,folder,{requireDisk:true});return p.jobs.map(j=>({uid:j.uid,id:j.id,state:j.state,sha256:j.attempts[0].rawSha256,videoId:j.attempts[0].videoId}));
  });
  console.log('Cold restart checkpoints: '+JSON.stringify(before));
  await active.page.close();await active.c.close();active=await persistent(true);
  const restartAt=Date.now();let states;
  do{states=await active.page.evaluate(async()=>{const p=await(await import('./src/storage.js')).get('state','project');return p.jobs.map(j=>({state:j.state,fullDecode:j.current?.qa?.fullDecode,error:j.error}));});if(states.length===3&&states.every(j=>j.state==='ready'&&j.fullDecode==='passed'))break;await active.page.waitForTimeout(300);}while(Date.now()-restartAt<120000);
  assert.ok(states.length===3&&states.every(j=>j.state==='ready'&&j.fullDecode==='passed'),JSON.stringify(states));
  const after=await active.page.evaluate(async()=>{const s=await import('./src/storage.js'),{sha256}=await import('./src/core.js'),p=await s.get('state','project'),folder=await s.getFolder();return await Promise.all(p.jobs.map(async j=>({uid:j.uid,id:j.id,state:j.state,sha256:await sha256(await s.readFile(folder,j.attempts[0].rawPath)),videoId:j.attempts[0].videoId,attempts:j.attempts.length,fullDecode:j.current?.qa?.fullDecode,error:j.error,lastProblem:j.attempts[0].lastProblem})));});
  console.log('Cold restart recovered: '+JSON.stringify(after));
  assert.equal(active.requests.core.length,0);assert.equal(active.requests.wasm.length,0);assert.equal(active.requests.worker.length,1);
  for(let i=0;i<3;i++){assert.equal(after[i].sha256,before[i].sha256);assert.equal(after[i].uid,before[i].uid);assert.equal(after[i].videoId,before[i].videoId);assert.equal(after[i].attempts,1);assert.equal(after[i].fullDecode,'passed');}
  reports.push({coldBrowserRestart:{before,after,elapsedMs:Date.now()-restartAt,requests:active.requests,engineNetworkBlocked:true}});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile('test-results/decoder-recovery-v1211-results.json',JSON.stringify({source,checks:reports,errors,external},null,2));console.log(JSON.stringify({passed:reports.length,checks:reports,errors,external},null,2));
}finally{await active?.c.close();}
