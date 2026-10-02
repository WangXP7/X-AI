// Inspect the already downloaded original task; no API and no user's browser state.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const context=await browser.newContext(),page=await context.newPage(),input=JSON.parse(await readFile('test-results/recover-original-input.json','utf8'));
  const config=await sealLocalDefault('sk-synthetic-inspection-only-key');await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
  await context.route('https://**',r=>r.abort());
  const data=await readFile('test-results/recovered-original.mp4');await context.route('**/__inspect.mp4',r=>r.fulfill({body:data,contentType:'video/mp4'}));
  await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  const result=await page.evaluate(async job=>{
    const {inspectVideo}=await import('./src/media.js'),f=await(await fetch('/__inspect.mp4')).blob(),q=await inspectVideo(f,job,{deep:true});
    const encode=async b=>{const bytes=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
    const frames=[];for(const frame of q.samples?.frames||[])frames.push(await encode(frame));const last=q.samples?await encode(q.samples.last):null;delete q.samples;return {qa:q,frames,last};
  },input.job);
  await mkdir('test-results/recovered-frames',{recursive:true});for(const [i,f] of result.frames.entries())await writeFile(`test-results/recovered-frames/frame_${i+1}.jpg`,Buffer.from(f,'base64'));
  if(result.last)await writeFile('test-results/recovered-frames/last.png',Buffer.from(result.last,'base64'));
  await writeFile('test-results/recovered-qa.json',JSON.stringify({at:new Date().toISOString(),qa:result.qa,frameCount:result.frames.length},null,2));console.log(JSON.stringify(result.qa,null,2));
}finally{await browser.close();}
