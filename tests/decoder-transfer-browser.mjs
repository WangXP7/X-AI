// Real streaming HTTP responses, normal browser CSP, and read-only original media.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {DECODER_ASSETS} from '../src/decoder-assets.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright');
const root=resolve('.'),wasm=await readFile('vendor/ffmpeg-core/ffmpeg-core.wasm'),fixture=await readFile(process.env.XAI_MEDIA_TEST_FILE||'tests/fixtures/synthetic.mp4');
const requests=[],errors=[],reports=[];let slow=false,noRange=false,interrupt=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost'),path=decodeURIComponent(u.pathname).slice(1)||'index.html';
  if(path==='__fixture.mp4'){res.writeHead(200,{'Content-Type':'video/mp4'});return res.end(fixture);}
  if(path.startsWith('private/')||path.startsWith('__xai_')){res.writeHead(404);return res.end();}
  if(path==='vendor/ffmpeg-core/ffmpeg-core.wasm'){
    const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||''),start=!noRange&&match?+match[1]:0,end=!noRange&&match?+match[2]:wasm.length-1;
    requests.push({start,end,range:req.headers.range,status:noRange?200:206});
    res.writeHead(noRange?200:206,{'Content-Type':'application/wasm','Content-Length':end-start+1,...(!noRange?{'Content-Range':`bytes ${start}-${end}/${wasm.length}`}:{})});res.flushHeaders();
    for(let offset=start;offset<=end;offset+=65536){if(res.destroyed)return;if(slow)await pause(250);res.write(wasm.subarray(offset,Math.min(offset+65536,end+1)));if(interrupt&&offset>=5*1048576+65536){interrupt=false;await pause(100);res.destroy();return;}}
    return res.end();
  }
  const file=resolve(root,path);if(!file.startsWith(root+sep)||path.startsWith('.')){res.writeHead(404);return res.end();}
  try{const body=await readFile(file),type=({html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',json:'application/json'})[file.split('.').at(-1)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(body);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({channel:'msedge',headless:true});let persistent;
async function ready(context){const page=context.pages()[0]||await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');return page;}
const decode=page=>page.evaluate(async()=>{const {deepCheck,videoMetadata}=await import('./src/media.js'),{sha256}=await import('./src/core.js'),file=await(await fetch('./__fixture.mp4')).blob(),start=Date.now(),phases=[];const result=await deepCheck(file,p=>{if(p.asset==='wasm'&&p.bytes!==undefined)phases.push({bytes:p.bytes,at:Date.now()-start});});return {elapsedMs:Date.now()-start,sha256:await sha256(file),size:file.size,metadata:await videoMetadata(file),result,phases};});
try{
  slow=true;const c=await browser.newContext(),page=await ready(c),start=requests.length,report=await decode(page);
  assert.ok(report.elapsedMs>120000,report.elapsedMs);assert.equal(report.result.fullDecode,'passed');assert.equal(requests.length-start,31);assert.equal(report.phases.at(-1).bytes,wasm.length);assert.ok(report.phases.every((p,i)=>!i||p.bytes>=report.phases[i-1].bytes));reports.push({slowBeyond120Seconds:report,rangeRequests:31});await writeFile('test-results/decoder-transfer-slow-v1212-results.json',JSON.stringify(reports[0],null,2));console.log('Slow streaming passed: '+report.elapsedMs+' ms');await c.close();slow=false;
  const profile=await mkdtemp(resolve('test-results/decoder-parts-profile-'));
  persistent=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true});let p=await ready(persistent);interrupt=true;const cutStart=requests.length;
  const cut=await p.evaluate(async()=>{try{await(await import('./src/decoder-assets.js')).decoderResources({nonce:'interruption'});return null;}catch(e){return e.decoderDiagnostic;}});
  assert.ok(cut);assert.equal(requests.length-cutStart,6);
  // Poison a complete cached part before closing the whole browser. Resume must
  // reject this untrusted entry, fetch it again, and keep the other valid parts.
  await p.evaluate(async sha=>{const cache=await caches.open('x-ai-verified-decoder-v1'),key=new URL('./vendor/ffmpeg-core/ffmpeg-core.wasm',location.href);key.searchParams.set('sha256',sha);key.searchParams.set('verified-part',2);await cache.put(key.href,new Response(new Uint8Array(1048576)));},DECODER_ASSETS[1].sha256);
  await persistent.close();persistent=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true});p=await ready(persistent);const resumeStart=requests.length,resumed=await decode(p),ranges=requests.slice(resumeStart);
  assert.equal(resumed.result.fullDecode,'passed');assert.equal(ranges.length,27);assert.equal(ranges[0].start,2*1048576);assert.ok(!ranges.some(x=>[0,1048576,3*1048576,4*1048576].includes(x.start)));reports.push({browserRestartResumesVerifiedParts:{diagnostic:cut,ranges,elapsedMs:resumed.elapsedMs,fullDecode:resumed.result.fullDecode}});await persistent.close();persistent=null;
  noRange=true;interrupt=true;const full=await browser.newContext(),fullPage=await ready(full),fallbackStart=requests.length,fallback=await decode(fullPage);
  assert.equal(fallback.result.fullDecode,'passed');assert.equal(requests.length-fallbackStart,2);assert.ok(requests.slice(fallbackStart).every(x=>x.status===200));reports.push({noRangeServerRecoversInterruptedFullStream:{requests:requests.slice(fallbackStart),elapsedMs:fallback.elapsedMs,fullDecode:fallback.result.fullDecode}});await full.close();
  assert.deepEqual(errors,[]);await writeFile('test-results/decoder-transfer-v1212-results.json',JSON.stringify({passed:reports.length,reports,errors},null,2));console.log(JSON.stringify({passed:reports.length,slow:reports[0].slowBeyond120Seconds.elapsedMs,metadata:reports[0].slowBeyond120Seconds.metadata,sha256:reports[0].slowBeyond120Seconds.sha256,errors}));
}finally{await persistent?.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
