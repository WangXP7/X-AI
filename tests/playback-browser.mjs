import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
const config=await sealLocalDefault('sk-synthetic-playback-not-a-live-key');await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4173/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  const result=await page.evaluate(async()=>{
    const file=await(await fetch('./tests/fixtures/synthetic.mp4')).blob(),url=URL.createObjectURL(file),assert=(condition,text)=>{if(!condition)throw Error(text);};
    const audio1=document.createElement('audio'),audio2=document.createElement('audio');for(const a of [audio1,audio2]){a.src=url;a.controls=true;a.loop=true;document.querySelector('#asset-library').append(a);}
    await audio1.play();await new Promise(r=>setTimeout(r,150));const position=audio1.currentTime;await audio2.play();await new Promise(r=>setTimeout(r,30));assert(audio1.paused&&!audio2.paused,'second sound must pause first');assert(audio1.currentTime>=position,'pause must preserve position');
    const video=document.createElement('video');video.src=url;video.controls=true;video.loop=true;document.querySelector('#jobs-grid').append(video);await video.play();await new Promise(r=>setTimeout(r,30));assert(audio2.paused&&!video.paused,'video must pause sound');
    const dialog=document.createElement('dialog'),preview=document.createElement('video');preview.src=url;preview.controls=true;preview.loop=true;dialog.append(preview);document.body.append(dialog);dialog.showModal();await preview.play();await new Promise(r=>setTimeout(r,30));assert(video.paused&&!preview.paused,'dialog preview must pause task video');dialog.close();await new Promise(r=>setTimeout(r,30));assert(preview.paused,'dialog close must pause preview');
    await video.play();await new Promise(r=>setTimeout(r,30));document.querySelector('[data-view=guide]').click();assert(video.paused,'page switch must pause hidden preview');
    const late=document.createElement('audio');late.src=url;late.loop=true;document.body.append(late);await late.play();await audio1.play();await new Promise(r=>setTimeout(r,30));assert(late.paused&&!audio1.paused,'new dynamic player must join mutual exclusion');
    const concurrentlyPlaying=[...document.querySelectorAll('audio,video')].filter(a=>!a.paused).length;assert(concurrentlyPlaying===1,'only one player may remain active');for(const a of [audio1,audio2,video,preview,late])a.pause();dialog.remove();audio1.remove();audio2.remove();video.remove();late.remove();URL.revokeObjectURL(url);
    return {checks:['second sound pauses first and preserves position','task video pauses library sound','dialog video pauses task video','closing preview pauses media','navigation pauses hidden playback','dynamic players share one active preview'],concurrentlyPlaying};
  });assert.deepEqual(errors,[]);await writeFile(new URL('../test-results/playback-results.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),...result,errors},null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
