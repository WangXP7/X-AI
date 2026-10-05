import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage();
const source=process.env.XAI_MEDIA_TEST_FILE||'tests/fixtures/synthetic.mp4',bytes=await readFile(source),errors=[];
const secrets=await sealLocalDefault('sk-synthetic-media-recovery');
let workerLoads=0;
await context.route('**/private/default-access.json',r=>r.fulfill({json:secrets}));
await context.route('https://**',r=>r.abort());
await context.route('**/__media-recovery.mp4',r=>r.fulfill({body:bytes,contentType:'video/mp4'}));
// Reproduce the actual promise failure mode: a worker exists but never replies.
await context.route('**/vendor/ffmpeg/worker.js',r=>++workerLoads===1?r.fulfill({body:'/* lost worker initialization: no reply */',contentType:'text/javascript'}):r.continue());
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 const result=await page.evaluate(async()=>{
   const {inspectVideo}=await import('./src/media.js'),{sha256}=await import('./src/core.js');
   const file=await(await fetch('./__media-recovery.mp4')).blob(),began=Date.now(),phases=[];
   const qa=await inspectVideo(file,{seconds:12,aspect:'9:16'},{onProgress:v=>phases.push(v.label)});
   return {elapsedMs:Date.now()-began,bytes:file.size,sha256:await sha256(file),qa:{...qa,samples:undefined},phases};
 });
 assert.ok(workerLoads>=2,'failed worker must be replaced automatically');assert.equal(result.qa.fullDecode,'passed');
 assert.ok(result.elapsedMs>=30000&&result.elapsedMs<90000);assert.deepEqual(errors,[]);
 await writeFile('test-results/media-recovery-v128-results.json',JSON.stringify({...result,workerLoads,errors},null,2));
 console.log(JSON.stringify({...result,workerLoads,errors},null,2));
}finally{await browser.close();}
