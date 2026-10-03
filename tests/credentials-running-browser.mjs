import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage();
const keyA='sk-synthetic-running-key-alpha',keyB='sk-synthetic-running-key-bravo',requests=[],errors=[];
await context.route('**/private/**',r=>r.fulfill({status:404,body:'not configured'}));
let release,mediaRequested=false;const gate=new Promise(resolve=>release=resolve),fixture=await readFile('tests/fixtures/synthetic.mp4');
await context.route('**/__xai_media',async r=>{mediaRequested=true;await gate;return r.fulfill({body:fixture,contentType:'video/mp4'});});
await context.route('https://api.agnes-ai.cn/**',r=>{
  const request=r.request();requests.push({method:request.method(),path:new URL(request.url()).pathname,keyA:request.headers().authorization==='Bearer '+keyA,keyB:request.headers().authorization==='Bearer '+keyB});
  return r.fulfill({json:{data:[{id:'agnes-video-2.5-flash'}]}});
});
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.XAI_TEST_URL||'http://127.0.0.1:4183/';
try{
  await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.evaluate(async()=>{
    const s=await import('./src/storage.js'),{newJob}=await import('./src/core.js'),p=await s.get('state','project');
    const j=newJob({id:'S06',episode:'EP01',prompt:'4秒测试',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});j.state='download';j.attempts=[{number:1,videoId:'synthetic_original_running',url:'https://cos-platform-outputs.agnes-ai.cn/videos/running.mp4',requestHash:'a'.repeat(64)}];p.jobs=[j];
    const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('running-key-fixture',{create:true});await s.put('handles','directory',folder);await s.saveProject(p,folder);
  });
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  for(let i=0;i<100&&!mediaRequested;i++)await page.waitForTimeout(100);assert.ok(mediaRequested);
  await page.locator('#settings-button').click();await page.locator('#basic-api-key').fill(keyA);await page.locator('#apply-basic-key').click();
  await page.waitForFunction(()=>document.querySelector('#settings-feedback').textContent.includes('新密钥已启用'));
  assert.equal(await page.locator('#basic-api-key').inputValue(),'');assert.equal(await page.locator('#test-connection').isEnabled(),true);
  await page.locator('#test-connection').click();await page.waitForFunction(()=>document.querySelector('#settings-feedback').textContent.includes('连接成功'));
  assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');assert.equal(requests[0].keyA,true);
  await page.locator('#basic-api-key').fill(keyB);await page.locator('#apply-basic-key').click();await page.waitForFunction(()=>document.querySelector('#settings-dialog').getAttribute('aria-busy')==='false');
  await page.locator('#test-connection').click();await page.waitForFunction(()=>document.querySelector('#settings-feedback').textContent.includes('连接成功'));
  assert.equal(requests.at(-1).keyB,true);assert.ok(!(await page.locator('#settings-feedback').textContent()).includes('暂停新提交'));
  await page.locator('#advanced-mode>summary').click();await page.locator('#lock-key').click();await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('未启用密钥'));
  release();await page.locator('#done-settings').click();await page.locator('[data-view=queue]').click();await page.locator('.job-card-head .status.ready').waitFor({timeout:60000});
  const actual=await page.evaluate(async()=>{const p=await(await import('./src/storage.js')).get('state','project');return {state:p.jobs[0].state,videoId:p.jobs[0].attempts[0].videoId,attempts:p.jobs[0].attempts.length,decode:p.jobs[0].current.qa.fullDecode};});
  assert.equal(actual.state,'ready');assert.equal(actual.videoId,'synthetic_original_running');assert.equal(actual.attempts,1);assert.equal(actual.decode,'passed');assert.ok(requests.every(r=>r.method==='GET'));
  const boundary=await page.evaluate(async({keyA,keyB})=>{
    const {Runner,Transport}=await import('./src/engine.js'),{makeProject,newJob}=await import('./src/core.js'),s=await import('./src/storage.js'),{pacingKey}=await import('./src/request-pacing.js');
    const p=makeProject(),t=new Transport(()=>({project:p})),real=fetch,calls=[];t.key=keyA;
    window.fetch=async(url,options)=>{calls.push({method:options.method,old:options.headers.Authorization==='Bearer '+keyA,new:options.headers.Authorization==='Bearer '+keyB});return new Response(JSON.stringify({video_id:'one-synthetic-post'}));};
    try{
      await s.put('state',pacingKey('agnes','submit'),{});
      await t.api('/v1/videos',{model:'agnes-video-2.5-flash'},async()=>{t.key=keyB;await new Promise(r=>setTimeout(r,20));});
      const snapshot=calls[0];await t.api('/v1/models');const next=calls.at(-1);
      await s.put('state',pacingKey('agnes','submit'),{notBefore:Date.now()+500,lastSentAt:0});
      const job=newJob({id:'S07',episode:'EP01',prompt:'4秒',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});p.jobs=[job];const r=new Runner(()=>({project:p,folder:null}),()=>{},()=>{});r.persist=async()=>{};r.transport.key=keyA;
      r.transport.onActivity=value=>{if(value.kind==='waiting')r.transport.key='';};const before=calls.length;await r.step(job);
      const unsent={state:job.state,calls:calls.length-before,attempts:job.attempts.length,sent:!!job.attempts[0].sentAt,submitted:!!job.attempts[0].submittedAt};
      const known=newJob({id:'S08',episode:'EP01',prompt:'4秒',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});known.state='queued';known.attempts=[{number:1,videoId:'original-known-id'}];p.jobs=[known];r.transport.key=keyA;await s.put('state',pacingKey('agnes','poll'),{});
      window.fetch=async()=>new Response(JSON.stringify({message:'Unauthorized'}),{status:401});await r.step(known);const authBlocked=known.state;
      r.transport.key=keyB;await r.credentialsReady();const resumed=known.state;
      window.fetch=async()=>new Response(JSON.stringify({status:'completed',url:'https://cos-platform-outputs.agnes-ai.cn/videos/known.mp4'}));await s.put('state',pacingKey('agnes','poll'),{});await r.step(known);
      return {snapshot,next,unsent,authBlocked,resumed,knownState:known.state,knownId:known.attempts[0].videoId,knownAttempts:known.attempts.length};
    }finally{window.fetch=real;}
  },{keyA,keyB});
  assert.equal(boundary.snapshot.old,true);assert.equal(boundary.next.new,true);assert.deepEqual(boundary.unsent,{state:'pending',calls:0,attempts:1,sent:false,submitted:false});
  assert.equal(boundary.authBlocked,'blocked');assert.equal(boundary.resumed,'queued');assert.equal(boundary.knownState,'download');assert.equal(boundary.knownId,'original-known-id');assert.equal(boundary.knownAttempts,1);assert.deepEqual(errors,[]);
  const report={passed:5,checks:['running download allows first key activation and GET connection check','key replacement uses new key; disabling key does not interrupt media download','request checkpoint uses immutable credential snapshot','key disabled during cooldown sends no POST and remains pending','new key resumes credential-rejected original GET without recreating task'],actual,boundary,requests,errors};
  await writeFile('test-results/credentials-running-v127-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{release();await browser.close();}
