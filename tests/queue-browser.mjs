// Controlled service responses; exercise the real refresh button and activity UI.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1500,height:1050}}),page=await context.newPage(),checks=[],errors=[];
const config=await sealLocalDefault('sk-synthetic-queue-ui-not-real'),fixture=await readFile(new URL('fixtures/synthetic.mp4',import.meta.url));
await mkdir('test-results',{recursive:true});await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
await context.route('**/__queue-fixture.mp4',r=>r.fulfill({body:fixture,contentType:'video/mp4'}));
let gets=0,posts=0;const requestTimes=[];
await context.route('https://api.agnes-ai.cn/**',async route=>{requestTimes.push(Date.now());if(route.request().method()==='POST'){posts++;return route.fulfill({json:{video_id:'should-not-be-created'}});}gets++;await new Promise(r=>setTimeout(r,1200));return route.fulfill({json:{status:'generating',progress:'46%'}});});
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.evaluate(async()=>{
    const s=await import('./src/storage.js'),{makeProject,newJob,sha256}=await import('./src/core.js'),{ensureStudios}=await import('./src/studio.js');
    const p=makeProject(),base={id:'S01',episode:'EP01',prompt:'小熊缓缓抬头',seconds:4,aspect:'9:16',mode:'text',assetIds:[],dialogue:''};
    const active=newJob(base);active.state='generating';active.progress=37;active.progressKnown=true;active.attempts=[{number:1,videoId:'existing-video-id',submittedAt:new Date(Date.now()-120000).toISOString(),polledAt:new Date(Date.now()-10000).toISOString()}];
    const ready=newJob({...base,id:'S02'});ready.state='ready';const file=await(await fetch('/__queue-fixture.mp4')).blob(),hash=await sha256(file);await s.storeBlob('queue-preview',file);
    ready.attempts=[{number:1,resolved:true,sha256:hash,blobKey:'queue-preview',path:'clips/EP01/S02_v1.mp4',qa:{technical:'passed',hasAudio:true}}];ready.current={...ready.attempts[0]};p.jobs=[active,ready,newJob({...base,id:'S03'})];ensureStudios(p);
    const out=await(await navigator.storage.getDirectory()).getDirectoryHandle('queue-progress-output',{create:true});await s.put('handles','directory',out);await s.saveProject(p,out);await s.put('state','rate',{last:Date.now()-90000,notBefore:Date.now()+6000});
  });
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');await page.locator('[data-view=queue]').click();
  assert.equal(await page.locator('#queue-total').innerText(),'3');assert.equal(await page.locator('#queue-ready').innerText(),'1');assert.equal(await page.locator('#queue-current-percent').innerText(),'处理中');await page.locator('.queue-progress-extra summary').click();
  const stamp=await page.locator('#queue-updated').innerText();await page.waitForTimeout(1100);assert.notEqual(await page.locator('#queue-updated').innerText(),stamp);
  await page.evaluate(()=>window.__queueVideo=document.querySelector('.job-preview video'));await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>__queueVideo===document.querySelector('.job-preview video')),true);checks.push('summary counts real jobs; service percentage and timestamps update without recreating preview media');
  await page.waitForFunction(()=>document.querySelector('#queue-phase').textContent.includes('等待请求间隔'));
  assert.equal(await page.locator('#start-queue').isDisabled(),true);assert.equal(gets,0);
  const countdown=await page.locator('#queue-phase').innerText();await page.locator('#refresh-queue').click();await page.waitForTimeout(1100);assert.notEqual(await page.locator('#queue-phase').innerText(),countdown);assert.equal(gets,0);
  await page.waitForFunction(()=>document.querySelector('#queue-phase').textContent.includes('正在查询服务端'));
  assert.ok(!(await page.locator('#queue-phase').innerText()).includes('89 秒'));
  await page.waitForFunction(()=>document.querySelectorAll('.job-card-head .status')[0]?.textContent==='生成中'&&document.querySelector('#queue-phase').textContent.includes('等待请求间隔'));assert.equal(gets,1);assert.equal(posts,0);
  let p=await page.evaluate(async()=>await(await import('./src/storage.js')).get('state','project'));assert.equal(p.jobs[0].attempts[0].videoId,'existing-video-id');assert.equal(p.jobs[0].attempts.length,1);checks.push('startup self-check resumes original ID after reserved rate slot; refresh preserves its countdown without creating pending expert tasks');
  await page.locator('#queue-filter').selectOption('ready');await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===1);assert.equal(await page.locator('#queue-total').innerText(),'3');await page.locator('#queue-filter').selectOption('all');
  await page.waitForFunction(()=>document.querySelector('#queue-phase').textContent.includes('等待请求间隔'));const before=gets;
  await page.locator('#refresh-queue').click();await page.locator('#refresh-queue').click();assert.equal(gets,before);assert.equal(posts,0);assert.equal(await page.locator('#start-queue').isDisabled(),true);
  await page.locator('#pause-queue').click();await page.waitForFunction(()=>document.querySelector('#queue-notice').textContent.includes('已暂停新提交'));assert.match(await page.locator('#queue-notice').innerText(),/已暂停新提交/);
  checks.push('refresh during running queue preserves countdown and runner without extra GET or POST; filters do not alter aggregate progress');
  await page.locator('#toast-region').evaluate(el=>el.replaceChildren());await page.screenshot({path:'test-results/queue-v115-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:'test-results/queue-v115-mobile.png',fullPage:true});checks.push('desktop and mobile refresh toolbar and progress remain readable without horizontal overflow');
  // Close the synthetic original runner; the next fixture starts with an empty application queue.
  await page.evaluate(async()=>{const s=await import('./src/storage.js'),{makeProject}=await import('./src/core.js');await s.saveProject(makeProject(),await s.getFolder());});
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  const engine=await page.evaluate(async()=>{
    const {Runner,Transport}=await import('./src/engine.js'),s=await import('./src/storage.js'),{makeProject,newJob}=await import('./src/core.js');
    const project=makeProject(),base={id:'SAFE',episode:'E01',seconds:4,aspect:'9:16',mode:'text',prompt:'测试',assetIds:[]};project.jobs=[newJob(base)];let writes=0;
    const r=new Runner(()=>({project,folder:null}),()=>{},()=>{});r.transport.api=async()=>{writes++;return {};};const local=await r.refreshStatus();
    const unknown=newJob({...base,id:'UNKNOWN'});unknown.state='unknown';unknown.attempts=[{number:1,submittedAt:new Date().toISOString()}];project.jobs.push(unknown);await r.refreshStatus();
    project.jobs=[];const known=newJob(base);known.state='queued';known.attempts=[{number:1,videoId:'keep-known'}];project.jobs=[known];const folder=await navigator.storage.getDirectory();r.context=()=>({project,folder});r.transport.key='synthetic';
    let polls=0;r.transport.api=async()=>{polls++;await new Promise(resolve=>setTimeout(resolve,80));return {status:'generating'};};await Promise.all([r.refreshStatus(),r.refreshStatus(),r.refreshStatus()]);
    const noPercent=known.progressKnown===false;let mediaCalls=0;r.transport.media=async()=>{mediaCalls++;throw Error('Refresh must not download');};r.transport.api=async()=>({status:'completed',url:'https://cdn.example.test/only-query.mp4'});await r.refreshStatus();const completedState=known.state;
    const originalFetch=window.fetch;let stream;const t=new Transport(()=>({project}),value=>stream=value);window.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(Object.assign(new Uint8Array(1000),{4:102,5:116,6:121,7:112}));controller.enqueue(new Uint8Array(1000));controller.close();}}),{headers:{'Content-Length':'2000'}});try{await t.media('https://cdn.example.test/download.mp4');}finally{window.fetch=originalFetch;}
    const activities=[],file=await(await fetch('/__queue-fixture.mp4')).blob(),checkRunner=new Runner(()=>({project,folder}),()=>{},()=>{});checkRunner.onActivity=()=>activities.push({...checkRunner.activity});await checkRunner.acceptFile(known,file);await checkRunner.assemble('E01');
    return {local:local.mode,writes,polls,noPercent,completedState,mediaCalls,downloadState:known.current?true:false,stream:{bytes:stream.bytes,total:stream.total},activities:activities.map(a=>a.label),videoId:known.attempts[0].videoId};
  });
  assert.equal(engine.writes,0);assert.equal(engine.local,'local');assert.equal(engine.polls,1);assert.equal(engine.noPercent,true);assert.equal(engine.videoId,'keep-known');assert.equal(engine.completedState,'download');assert.equal(engine.mediaCalls,0);assert.deepEqual(engine.stream,{bytes:2000,total:2000});assert.ok(engine.activities.some(a=>a?.includes('抽帧')));assert.ok(engine.activities.some(a=>a?.includes('解码')));assert.ok(engine.activities.some(a=>a?.includes('拼接')));assert.ok(engine.activities.some(a=>a?.includes('保存分集')));checks.push('idle/unknown refresh is local only; concurrent refreshes coalesce; stream byte and real media check / assemble activity are reported');
  assert.deepEqual(errors,[]);await writeFile('test-results/queue-v123-results.json',JSON.stringify({at:new Date().toISOString(),checks,errors,gets,posts,engine},null,2));console.log(JSON.stringify({checks,errors,gets,posts},null,2));
}finally{await browser.close();}
