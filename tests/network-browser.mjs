import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
const results={checks:[],errors:[],apiPosts:0,mediaRecoveries:0};
try{
  const context=await browser.newContext({viewport:{width:1500,height:950}}),page=await context.newPage(),config=await sealLocalDefault('sk-synthetic-no-real-api');
  await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
  await context.route('https://**',r=>{if(r.request().method()==='POST')results.apiPosts++;return r.abort();});
  page.on('pageerror',e=>results.errors.push(e.message));
  await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');await page.locator('[data-view=queue]').click();
  const layout=await page.evaluate(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {filter:rect('queue-filter'),refresh:rect('refresh-queue'),total:rect('queue-total'),panel:rect('queue-progress-panel'),emptyBarHidden:getComputedStyle(document.querySelector('#queue-current-bar')).display==='none',font:parseFloat(getComputedStyle(document.querySelector('.queue-counters')).fontSize)};});
  assert.ok(Math.abs(layout.filter.y-layout.refresh.y)<5);assert.ok(layout.total.x>layout.refresh.x+layout.refresh.width);assert.ok(layout.panel.height<130);assert.ok(layout.font>=14);assert.equal(layout.emptyBarHidden,true);
  await page.screenshot({path:'test-results/queue-v116-empty.png',fullPage:true});results.layout=layout;results.checks.push('filter, refresh and totals share desktop row; empty progress has no misleading animation; details collapsed');
  const fixture=await readFile('tests/fixtures/synthetic.mp4');
  await context.route('**/__xai_media',async r=>{results.mediaRecoveries++;assert.equal(r.request().headers().authorization,undefined);assert.equal(r.request().headers().cookie,undefined);assert.equal(JSON.parse(r.request().postData()).url,'https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4');return r.fulfill({body:fixture,contentType:'video/mp4',headers:{'Content-Length':String(fixture.length)}});});
  const engine=await page.evaluate(async()=>{
    const {Runner}=await import('./src/engine.js'),s=await import('./src/storage.js'),{makeProject,newJob}=await import('./src/core.js');
    const project=makeProject(),job=newJob({id:'S01',episode:'EP01',prompt:'测试',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});
    job.state='blocked';job.error='旧泛化网络错误';job.attempts=[{number:1,videoId:'original-known-id',url:'https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4',pollResponse:{status:'completed',progress:100}}];project.jobs=[job];
    const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('network-fixture',{create:true});await s.put('handles','directory',folder);await s.saveProject(project,folder);
    const runner=new Runner(()=>({project,folder}),()=>{},()=>{});runner.transport.key='synthetic';runner.transport.api=async()=>{throw Error('Should not query or create completed task');};await runner.retryDownload(job);
    return {state:job.state,videoId:job.attempts[0].videoId,attempts:job.attempts.length,qa:job.current?.qa};
  });
  assert.equal(engine.state,'ready');assert.equal(engine.videoId,'original-known-id');assert.equal(engine.attempts,1);assert.equal(engine.qa.fullDecode,'passed');assert.equal(results.apiPosts,0);assert.equal(results.mediaRecoveries,1);results.engine=engine;
  results.checks.push('known generated video downloads through same-origin local media, no credentials, API POST or new attempt; real video decodes');
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');await page.locator('[data-view=queue]').click();
  await page.evaluate(async()=>{const s=await import('./src/storage.js'),p=await s.get('state','project');p.jobs[0].current=null;p.jobs[0].state='blocked';p.jobs[0].error='旧连接被跨域拦截';delete p.jobs[0].attempts[0].resolved;p.jobs[0].attempts[0].lastProblem={operation:'media'};delete p.jobs[0].attempts[0].rawBlobKey;delete p.jobs[0].attempts[0].rawPath;await s.saveProject(p,await s.getFolder());});
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');await page.locator('[data-view=queue]').click();await page.locator('.job-card-head .status.ready').waitFor({timeout:120000});assert.equal(await page.locator('[data-download-help]').count(),0);assert.equal(await page.locator('[data-retry-download]').count(),0);
  await page.locator('.queue-progress-extra summary').click();assert.equal(await page.locator('#queue-stages').isVisible(),true);await page.locator('.queue-progress-extra summary').click();
  await page.screenshot({path:'test-results/queue-v116-blocked.png',fullPage:true});
  for(const width of [1280,850,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);}
  await page.screenshot({path:'test-results/queue-v116-mobile.png',fullPage:true});results.checks.push('legacy download failures automatically recover on reload without recovery/help actions; expandable stages; desktop/tablet/mobile no overflow');
  await page.evaluate(async()=>{const s=await import('./src/storage.js'),p=await s.get('state','project'),stale=structuredClone(p);stale.updatedAt='2026-10-01T00:00:00Z';p.updatedAt='2026-10-03T00:00:00Z';p.jobs[0].state='ready';p.jobs[0].error=null;p.jobs[0].current={...p.jobs[0].attempts[0]};await s.saveProject(p,await s.getFolder());await s.put('state','project',stale);});
  await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');await page.locator('[data-view=queue]').click();
  assert.equal(await page.locator('#queue-ready').innerText(),'1');assert.equal(await page.evaluate(async()=>JSON.parse(await(await(await import('./src/storage.js')).readFile(await(await import('./src/storage.js')).getFolder(),'project.json')).text()).jobs[0].state),'ready');
  results.checks.push('newer matching disk recovery is verified before startup save; stale browser copy cannot overwrite restored task');
  assert.deepEqual(results.errors,[]);await writeFile('test-results/network-v122-results.json',JSON.stringify({at:new Date().toISOString(),...results},null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
