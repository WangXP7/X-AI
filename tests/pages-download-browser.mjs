// Isolated browser: production Pages origin + local release files, real browser
// CORS and real Python/CDN transfer. Never access the user's browser or send a
// paid generation POST. Requires the explicitly configured loopback server.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {sealLocalDefault} from '../src/local-default.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright');
const root=resolve('.'),base='https://wangxp7.github.io/X-AI/';
const release='v'+JSON.parse(await readFile('package.json','utf8')).version.replaceAll('.','');
const url='https://cos-platform-outputs.agnes-ai.cn/videos/agnes-video-2.5/task_vuPCudMYJKN3P9Po28Ek4IN6rmV6rYIA.mp4';
const browser=await chromium.launch({channel:'msedge',headless:true}),events=[],errors=[];
const secrets=await sealLocalDefault('sk-synthetic-pages-download-only');
async function open(permissions){
  const context=await browser.newContext();
  if(permissions)await context.grantPermissions(permissions,{origin:new URL(base).origin});
  await context.route('https://wangxp7.github.io/**',async route=>{
    const path=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/X-AI\//,'')||'index.html';
    if(path==='private/default-access.json')return route.fulfill({json:secrets});
    const file=resolve(root,path);
    if(!file.startsWith(root+sep)||path.startsWith('private/')||path.startsWith('.'))return route.fulfill({status:404});
    const ext=file.split('.').at(-1),types={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',wasm:'application/wasm',mp4:'video/mp4'};
    try{return route.fulfill({body:await readFile(file),contentType:types[ext]||'application/octet-stream'});}catch{return route.fulfill({status:404});}
  });
  await context.route(/https:\/\/(api\.agnes-ai\.cn|apihub\.agnes-ai\.com)\//,route=>{events.push({forbiddenGenerationAPI:true});return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().startsWith('http://127.0.0.1'))events.push({method:r.method(),path:new URL(r.url()).pathname});});
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  return {context,page};
}
try{
  // Explicit denied case: no blind repeated requests or fabricated completion.
  const denied=await open([]);
  const deniedResult=await denied.page.evaluate(async url=>{
    const {Transport}=await import('./src/engine.js'),{makeProject}=await import('./src/core.js');
    let permission='unsupported';try{permission=(await navigator.permissions.query({name:'local-network-access'})).state;}catch{}
    const t=new Transport(()=>({project:makeProject()}));let failure;
    try{await t.media(url);}catch(e){failure={code:e.code,waitingFor:e.waitingFor,retryIn:Math.round((e.retryAt-Date.now())/1000),diagnostic:e.diagnostic};}
    return {origin:location.origin,permission,failure};
  },url);
  assert.equal(deniedResult.permission,'denied');assert.equal(deniedResult.failure.code,'media_channel_unavailable');
  assert.equal(deniedResult.failure.waitingFor,'browser-permission');assert.equal(deniedResult.failure.diagnostic.channels.length,1);
  await denied.context.close();
  const allowed=await open(['local-network-access']);
  const result=await allowed.page.evaluate(async url=>{
    const {Runner}=await import('./src/engine.js'),{makeProject,newJob,sha256}=await import('./src/core.js'),s=await import('./src/storage.js'),{remoteBlocks}=await import('./src/queue-health.js');
    let direct;try{await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(15000)});direct='unexpected-readable';}catch(e){direct=e.name;}
    const p=makeProject(),j=newJob({id:'S04',episode:'EP01',prompt:'生成12秒，9:16竖屏',seconds:12,aspect:'9:16',mode:'text',assetIds:[]});
    j.uid='isolated-S04-v126';j.state='download';j.attempts=[{number:1,videoId:'task_vuPCudMYJKN3P9Po28Ek4IN6rmV6rYIA',url,requestHash:'a'.repeat(64),downloadFailures:55,downloadRecovery:true}];p.jobs=[j];
    const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('pages-original-S04',{create:true});
    const runner=new Runner(()=>({project:p,folder}),()=>{},()=>{});const before=Date.now();
    await runner.step(j);await Promise.all(runner.localChecks.values());
    const a=j.attempts[0],raw=await s.readFile(folder,a.rawPath),clip=await s.readFile(folder,a.path),receipt=JSON.parse(await(await s.readFile(folder,a.rawPath+'.json')).text());
    const bytes=new Uint8Array(await raw.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {origin:location.origin,version:document.documentElement.dataset.runtimeVersion,permission:(await navigator.permissions.query({name:'local-network-access'})).state,direct,elapsedMs:Date.now()-before,
      state:j.state,error:j.error,qa:a.qa,bytes:raw.size,sha256:await sha256(raw),clipSha256:await sha256(clip),receipt,diagnostic:a.downloadDiagnostic,remoteBlocks:remoteBlocks(j),videoId:a.videoId,attempts:j.attempts.length,raw:btoa(binary)};
  },url);
  assert.equal(result.origin,'https://wangxp7.github.io');assert.equal(result.direct,'TypeError');assert.equal(result.state,'ready',result.error);
  assert.equal(result.qa.fullDecode,'passed');assert.equal(result.bytes,2443464);assert.equal(result.sha256,result.clipSha256);assert.equal(result.receipt.sha256,result.sha256);
  assert.equal(result.diagnostic.channels[0].channel,'automatic');assert.equal(result.diagnostic.channels[0].result,'success');assert.equal(result.remoteBlocks,false);
  assert.equal(result.attempts,1);assert.equal(result.videoId,'task_vuPCudMYJKN3P9Po28Ek4IN6rmV6rYIA');assert.ok(!events.some(x=>x.forbiddenGenerationAPI));assert.deepEqual(errors,[]);
  const renewed=await allowed.page.evaluate(async url=>{
    const {Transport}=await import('./src/engine.js'),{makeProject}=await import('./src/core.js');
    const t=new Transport(()=>({project:makeProject()}));await t.mediaRelay.discover(url);
    t.mediaRelay.cached.token='1.'+'a'.repeat(64);
    const file=await t.media(url);return {bytes:file.size,diagnostic:file.downloadDiagnostic};
  },url);
  assert.equal(renewed.diagnostic.channels[0].code,'media_session_expired');assert.equal(renewed.diagnostic.channels.at(-1).result,'success');assert.equal(renewed.bytes,result.bytes);
  // One unavailable handshake simulates a service being restarted. The actual
  // Runner must resume without a click, using its real 30-second recovery timer.
  let outages=0;
  await allowed.context.route('http://127.0.0.1:4183/__xai_media_session',route=>++outages===1?route.abort():route.continue());
  const recovered=await allowed.page.evaluate(async url=>{
    const {Runner}=await import('./src/engine.js'),{makeProject,newJob}=await import('./src/core.js');
    const p=makeProject(),j=newJob({id:'S04',episode:'EP01',prompt:'生成12秒，9:16竖屏',seconds:12,aspect:'9:16',mode:'text',assetIds:[]});
    j.uid='isolated-outage-S04';j.state='download';j.attempts=[{number:1,videoId:'task_vuPCudMYJKN3P9Po28Ek4IN6rmV6rYIA',url,requestHash:'b'.repeat(64)}];p.jobs=[j];
    const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('pages-service-outage',{create:true}),phases=[];
    const r=new Runner(()=>({project:p,folder}),()=>{const value=j.attempts[0].downloadWaitingFor;if(value&&!phases.includes(value))phases.push(value);},()=>{}),start=Date.now();
    await r.start({automatic:true});return {elapsedMs:Date.now()-start,state:j.state,phases,failures:j.attempts[0].downloadFailures,decode:j.current?.qa.fullDecode,attempts:j.attempts.length};
  },url);
  assert.equal(recovered.state,'ready');assert.equal(recovered.decode,'passed');assert.equal(recovered.failures,1);assert.equal(recovered.attempts,1);assert.deepEqual(recovered.phases,['local-service']);assert.ok(recovered.elapsedMs>=30000&&recovered.elapsedMs<90000);
  const raw=Buffer.from(result.raw,'base64');delete result.raw;assert.equal(createHash('sha256').update(raw).digest('hex'),result.sha256);
  await mkdir('test-results',{recursive:true});await writeFile(`test-results/S04-pages-${release}.mp4`,raw);
  assert.deepEqual(errors,[]);assert.ok(!events.some(x=>x.forbiddenGenerationAPI));
  const output={browser:browser.version(),security:'Normal browser security; local-network permission tested denied and granted explicitly',staticSource:'local release served at the real Pages origin by isolated test routing; not a live deployment',upstream:'real S04 CDN through real loopback server; no mock',denied:deniedResult,result,renewed,recovered,events,errors};
  await writeFile(`test-results/pages-download-${release}-results.json`,JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
}finally{await browser.close();}
