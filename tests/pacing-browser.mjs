import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright'),browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
const config=await sealLocalDefault('sk-synthetic-pacing-only');await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));await context.route('https://**',r=>{errors.push('Unexpected real API');return r.abort();});page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
 const result=await page.evaluate(async()=>{
  const {Transport,Runner}=await import('./src/engine.js'),{makeProject,newJob}=await import('./src/core.js'),{pacingKey}=await import('./src/request-pacing.js'),s=await import('./src/storage.js');
  const realFetch=fetch,realNow=Date.now,realTimeout=setTimeout,fixture=await(await fetch('./tests/fixtures/synthetic.mp4')).blob(),p=makeProject();let clock=1000000,reply={status:200,body:{status:'queued'}},requests=[];
  try{
   Date.now=()=>clock;window.setTimeout=(fn,ms,...a)=>{clock+=ms;return realTimeout(fn,0,...a);};
   window.fetch=async(url,options={})=>{requests.push({url:String(url).split('?')[0],method:options.method,at:clock});if(reply.media)return new Response(fixture,{headers:{'Content-Type':'video/mp4','Content-Length':String(fixture.size)}});return new Response(JSON.stringify(reply.body),{status:reply.status,headers:reply.headers||{}});};
   await s.put('state','rate',{last:clock,notBefore:clock+3600000});
   const t=new Transport(()=>({project:p}));t.key='synthetic';reply.body={video_id:'first'};await t.api('/v1/videos',{model:'agnes-video-2.5-flash'});const first=clock;
   reply.body={status:'queued'};await t.api('/agnesapi?video_id=first');const firstQuery=clock;await t.api('/agnesapi?video_id=first');const queryGap=clock-firstQuery;
   const fresh=new Transport(()=>({project:p}));fresh.key='synthetic';reply.body={video_id:'second'};await fresh.api('/v1/videos',{model:'agnes-video-2.5-flash'});const submitGap=clock-first;
   const intervals=[];for(const status of [429,429,200,200]){reply={status,body:status===200?{status:'queued'}:{code:'rate_limit_exceeded'}};try{await t.api('/agnesapi?video_id=first');}catch(e){if(e.status!==429)throw e;}intervals.push((await s.get('state',pacingKey('agnes','poll'))).intervalMs);}
   reply={status:429,body:{code:'rate_limit_exceeded'},headers:{'Retry-After':'120'}};try{await t.api('/agnesapi?video_id=first');}catch{}const punished=clock;reply={status:200,body:{status:'completed'}};await t.api('/agnesapi?video_id=first');const retryAfterWait=clock-punished;
   const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('pacing-test',{create:true}),job=newJob({id:'S03',episode:'E01',prompt:'4秒',seconds:4,aspect:'9:16',mode:'text',assetIds:[]});job.state='queued';job.attempts=[{number:1,videoId:'known',firstPollAt:clock+20000}];p.jobs=[job];await s.remove('state',pacingKey('agnes','poll'));
   const runner=new Runner(()=>({project:p,folder}),()=>{},()=>{});runner.transport.key='synthetic';reply={status:200,body:{status:'completed',url:'https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4'}};const beforePoll=clock;await runner.step(job);const estimatedFirstPoll=clock-beforePoll;
   // Media 429: stop channel switching, retain Retry-After, then recover only download.
   reply={status:502,body:{upstreamStatus:429,retryAfter:'25'}};const beforeMedia=requests.length;let mediaError;try{await t.media(job.attempts[0].url);}catch(e){mediaError=e;}const mediaPenaltyAt=clock,mediaRequests=requests.length-beforeMedia;
   reply={media:true};const downloaded=await t.media(job.attempts[0].url);const mediaWait=clock-mediaPenaltyAt;
   const concurrentStart=clock;await s.put('state',pacingKey('agnes','submit'),{lastSentAt:clock,notBefore:clock+61000});let waiting=false;const concurrent=new Transport(()=>({project:p}),v=>{if(v.kind==='waiting'&&v.operation==='submit')waiting=true;});concurrent.key='synthetic';reply={status:200,body:{video_id:'third'}};
   const pending=concurrent.api('/v1/videos',{model:'agnes-video-2.5-flash'});while(!waiting)await new Promise(resolve=>realTimeout(resolve,0));await concurrent.api('/v1/models');const concurrentQueryAt=clock;await pending;const concurrentPostAt=requests.findLast(r=>r.method==='POST'&&r.url.endsWith('/v1/videos')).at;
   return {first,firstQuery,queryGap,submitGap,intervals,retryAfterWait,estimatedFirstPoll,state:job.state,mediaRequests,mediaPenalty:mediaError?.penalty,mediaWait,mediaBytes:downloaded.size,fixtureBytes:fixture.size,concurrentStart,concurrentQueryAt,concurrentPostAt,requests};
  }finally{window.fetch=realFetch;Date.now=realNow;window.setTimeout=realTimeout;}
 });
 assert.equal(result.firstQuery,result.first);assert.equal(result.queryGap,10000);assert.equal(result.submitGap,61000);assert.deepEqual(result.intervals,[15000,20000,15000,10000]);assert.equal(result.retryAfterWait,120000);assert.equal(result.estimatedFirstPoll,20000);assert.equal(result.state,'download');assert.equal(result.mediaRequests,1);assert.equal(result.mediaPenalty,true);assert.equal(result.mediaWait,25000);assert.equal(result.mediaBytes,result.fixtureBytes);assert.ok(result.concurrentQueryAt<result.concurrentPostAt);assert.ok(result.concurrentPostAt-result.concurrentStart>=61000);assert.deepEqual(errors,[]);
 await writeFile('test-results/pacing-v125-results.json',JSON.stringify({passed:6,result,errors},null,2));console.log(JSON.stringify({passed:6,...result,errors},null,2));
}finally{await browser.close();}
