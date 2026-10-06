import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage(),fixture=await readFile('tests/fixtures/synthetic.mp4'),errors=[],upstream=[];
let release,mediaRequested=false;const gate=new Promise(r=>release=r);
await context.addInitScript(()=>{FileSystemDirectoryHandle.prototype.queryPermission=async()=> 'granted';});
await context.route('**/private/**',r=>r.fulfill({status:404}));
await context.route('https://**',r=>{upstream.push(r.request().url());return r.abort();});
await context.route('**/__xai_media',async r=>{mediaRequested=true;await gate;return r.fulfill({body:fixture,contentType:'video/mp4'});});
await context.route('**/__fixture.mp4',r=>r.fulfill({body:fixture,contentType:'video/mp4'}));
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  const original=await page.evaluate(async()=>{
    const s=await import('./src/storage.js'),{newJob,sha256}=await import('./src/core.js'),p=await s.get('state','project'),raw=await(await fetch('./__fixture.mp4')).blob(),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('content-review-fixture',{create:true});
    const job=id=>{const j=newJob({id,episode:'EP01',prompt:'original submitted prompt',seconds:12,aspect:'21:9',mode:'text',assetIds:[]});j.current={number:1,path:`clips/EP01/${id}_v1.mp4`,blobKey:'clip:'+j.uid,sha256:'a'.repeat(64),qa:{technical:'failed',fullDecode:'passed',width:1470,height:630,duration:12.256,fatal:['分辨率1470×630明显低于720P。']}};j.state='needs_redo';j.review='pending';j.error=j.current.qa.fatal[0];j.attempts=[{...structuredClone(j.current),videoId:'original-'+id,resolved:true}];return j;};
    const j=job('S18'),good=job('S19');good.aspect='9:16';good.state='ready';good.error=null;good.current.qa={technical:'passed',fullDecode:'passed',fatal:[],duration:4};
    for(const x of [j,good]){x.current.sha256=await sha256(raw);x.attempts[0].sha256=x.current.sha256;await s.storeBlob(x.current.blobKey,raw);await s.writeFile(folder,x.current.path,raw);}
    const processing=newJob({id:'S26',episode:'EP01',prompt:'already generated',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});processing.state='download';processing.attempts=[{number:2,videoId:'original-processing-id',url:'https://cos-platform-outputs.agnes-ai.cn/videos/synthetic.mp4',requestHash:'b'.repeat(64)}];
    p.jobs=[j,good,processing];await s.put('handles','directory',folder);await s.saveProject(p,folder,{requireDisk:true});return {uid:j.uid,goodUid:good.uid,processingUid:processing.uid,attempts:j.attempts,qa:j.current.qa};
  });
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');for(let i=0;i<50&&!mediaRequested;i++)await page.waitForTimeout(100);assert.ok(mediaRequested);
  await page.locator('[data-view=queue]').click();await page.locator(`[data-detail="${original.uid}"]`).click();assert.equal(await page.locator('[data-review-pass]').isEnabled(),true);
  page.once('dialog',d=>d.dismiss());await page.locator('[data-review-pass]').click();
  const pending=await page.evaluate(async uid=>(await(await import('./src/storage.js')).get('state','project')).jobs.find(j=>j.uid===uid).review,original.uid);assert.equal(pending,'pending');
  page.once('dialog',d=>d.accept());await page.locator('[data-review-pass]').click();await page.waitForFunction(()=>document.querySelector('#detail-body').textContent.includes('人工内容审核：approved'));
  const saved=await page.evaluate(async uid=>{const s=await import('./src/storage.js'),p=await s.get('state','project'),folder=await s.getFolder(),disk=JSON.parse(await(await s.readFile(folder,'project.json')).text());return {j:p.jobs.find(j=>j.uid===uid),disk:disk.jobs.find(j=>j.uid===uid),processing:p.jobs.at(-1),events:p.events.filter(e=>e.kind==='human_approved')};},original.uid);
  assert.equal(saved.j.review,'approved');assert.equal(saved.j.state,'needs_redo');assert.equal(saved.disk.review,'approved');assert.deepEqual(saved.j.current.qa,original.qa);assert.deepEqual(saved.j.attempts,original.attempts);assert.equal(saved.processing.state,'download');assert.equal(saved.processing.attempts.length,1);assert.equal(saved.events.length,1);
  assert.ok((await page.locator('#detail-title').textContent()).includes('内容已通过 · 技术待处理'));
  page.once('dialog',d=>d.accept('合成测试：对白不合格'));await page.locator('[data-review-fail]').click();await page.waitForFunction(()=>document.querySelector('#detail-body').textContent.includes('人工内容审核：rejected'));
  await page.locator('#detail-dialog .close-dialog').click();await page.locator(`[data-detail="${original.goodUid}"]`).click();page.once('dialog',d=>d.accept());await page.locator('[data-review-pass]').click();await page.waitForFunction(()=>document.querySelector('#detail-body').textContent.includes('人工内容审核：approved'));
  const failures=await page.evaluate(async()=>{
    const {Runner}=await import('./src/engine.js'),{reviewStamp}=await import('./src/content-review.js'),{makeProject,newJob}=await import('./src/core.js'),s=await import('./src/storage.js');
    const p=makeProject(),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('review-rollback',{create:true}),j=newJob({id:'T01',episode:'EP01',prompt:'test',seconds:12,aspect:'16:9',mode:'text',assetIds:[]});j.state='ready';j.current={number:1,sha256:'c'.repeat(64),qa:{technical:'passed',fullDecode:'passed',fatal:[]}};j.attempts=[{number:1,videoId:'same-original',resolved:true}];p.jobs=[j];const runner=new Runner(()=>({project:p,folder}),()=>{},()=>{});runner.activeUid='other-task';runner.localChecks.set('other-task',{});
    const before=structuredClone(j),old=FileSystemDirectoryHandle.prototype.getFileHandle;let failure;
    FileSystemDirectoryHandle.prototype.getFileHandle=async function(name,options){if(name==='project.json'&&options?.create){p.events.push({kind:'other-job-progress',at:new Date().toISOString(),message:'other job continues'});throw new DOMException('quota test','QuotaExceededError');}return old.call(this,name,options);};
    try{await runner.review(j,{decision:'approved'});}catch(e){failure=e.name;}finally{FileSystemDirectoryHandle.prototype.getFileHandle=old;}
    const restored=structuredClone(j),noFalseEvent=!p.events.some(e=>e.kind==='human_approved'),otherEvent=p.events.some(e=>e.kind==='other-job-progress');
    await runner.review(j,{decision:'approved'});const retry=j.state;const stamp=reviewStamp(j);j.current.number=2;let stale;try{await runner.review(j,{decision:'rejected',reason:'test',expectedStamp:stamp});}catch(e){stale=e.message;}
    runner.localChecks.set(j.uid,{});let own;try{await runner.review(j,{decision:'approved'});}catch(e){own=e.message;}
    return {before,restored,failure,noFalseEvent,otherEvent,retry,stale,own,reviewing:runner.reviewing.size};
  });
  assert.deepEqual(failures.restored,failures.before);assert.equal(failures.failure,'QuotaExceededError');assert.ok(failures.noFalseEvent&&failures.otherEvent);assert.equal(failures.retry,'approved');assert.match(failures.stale,/变化/);assert.match(failures.own,/此任务正在处理/);assert.equal(failures.reviewing,0);
  assert.deepEqual(upstream,[]);assert.deepEqual(errors,[]);const report={passed:7,checks:['cancel preserves review','other active job does not block S18','content result saved to disk without overriding technical QA/history','rejection reason saved','technically valid video approved while queue active','failed disk write rolls back only review and preserves other progress; retry succeeds','stale version and own processing rejected'],saved,failures,errors,realPlatformRequests:upstream.length};await writeFile('test-results/content-review-v1212-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:7,errors,realPlatformRequests:0}));
}finally{release();await browser.close();}
