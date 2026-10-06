import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaEngineQueue} from '../src/media-engine.js';

test('lost worker initialization times out and next instance completes the same check',async()=>{
  let made=0,terminated=0;
  const queue=new MediaEngineQueue(()=>({load:()=>++made===1?new Promise(()=>{}):Promise.resolve(),terminate(){terminated++;}}),{loadTimeout:15});
  assert.equal(await queue.run(()=>42),42);assert.equal(made,2);assert.ok(terminated>=1);
});
test('lost worker operation releases serial queue so later media checks run',async()=>{
  let made=0,terminated=0;
  const queue=new MediaEngineQueue(()=>{made++;return {load:async()=>{},terminate(){terminated++;}};},{loadTimeout:15});
  const first=queue.run(()=>new Promise(()=>{}),{timeout:15}),second=queue.run(()=>99);
  await assert.rejects(first,error=>error.name==='LocalCheckUnavailable'&&/超时/.test(error.message));assert.equal(await second,99);assert.equal(made,2);assert.ok(terminated>=1);
});
test('persistent startup failure stays an error and does not poison later retry',async()=>{
  let fail=true;
  const queue=new MediaEngineQueue(()=>({load:()=>fail?new Promise(()=>{}):Promise.resolve(),terminate(){}}),{loadTimeout:10,retryDelay:0});
  await assert.rejects(queue.run(()=>true),error=>error.name==='LocalCheckUnavailable'&&/超时/.test(error.message));fail=false;assert.equal(await queue.run(()=>true),true);
});

test('a shared startup failure pauses waiting jobs once, then retries after recovery',async()=>{
  let made=0,failed=true;const options=[];
  const queue=new MediaEngineQueue(o=>{made++;options.push(o);return {load:async()=>{if(failed)throw Error('offline');},terminate(){}};},{retryDelay:25});
  const results=await Promise.allSettled([queue.run(()=>1),queue.run(()=>2),queue.run(()=>3)]);
  assert.equal(made,2);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.retryAt>0));
  assert.notEqual(options[0].nonce,options[1].nonce);assert.deepEqual(options.map(o=>o.attempt),[0,1]);
  failed=false;await new Promise(r=>setTimeout(r,30));assert.equal(await queue.run(()=>4),4);assert.equal(made,3);
});

test('factory timeout aborts loading and disposes late instances instead of leaking workers',async()=>{
  let terminated=0,signals=[];
  const queue=new MediaEngineQueue(({signal})=>{signals.push(signal);return new Promise(r=>setTimeout(()=>r({load:async()=>{},terminate(){terminated++;}}),30));},{factoryTimeout:5,retryDelay:0});
  await assert.rejects(queue.run(()=>true),e=>e.decoderDiagnostic.stage==='assets');
  await new Promise(r=>setTimeout(r,40));assert.equal(terminated,2);assert.ok(signals.every(s=>s.aborted));assert.equal(queue.pending,0);
});

test('queued media reports waiting separately from decoder startup',async()=>{
  let release;const phases=[];
  const queue=new MediaEngineQueue(()=>({load:async()=>{},terminate(){}}));
  const first=queue.run(()=>new Promise(r=>release=r));const second=queue.run(()=>2,{onProgress:p=>phases.push(p.label)});
  await new Promise(r=>setTimeout(r,0));release(1);assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.match(phases[0],/前方还有 1 项/);
});

test('actual new bytes keep a slow factory alive beyond the former total deadline',async()=>{
  let made=0;const queue=new MediaEngineQueue(async({onProgress})=>{made++;for(let bytes=1;bytes<=8;bytes++){await new Promise(r=>setTimeout(r,8));onProgress({asset:'wasm',bytes});}return {load:async()=>{},terminate(){}};},{factoryTimeout:25,factoryMaxTime:500});
  const start=Date.now();assert.equal(await queue.run(()=>42),42);assert.ok(Date.now()-start>25);assert.equal(made,1);
});

test('repeated labels or unchanged byte counts do not hide a stalled download',async()=>{
  const timers=[];const queue=new MediaEngineQueue(({onProgress,signal})=>new Promise(()=>{onProgress({bytes:1});const timer=setInterval(()=>onProgress({label:'still loading',bytes:1}),4);timers.push(timer);signal.addEventListener('abort',()=>clearInterval(timer));}),{factoryTimeout:20,retryDelay:0});
  try{await assert.rejects(queue.run(()=>true),e=>e.decoderDiagnostic.code==='timeout');assert.equal(queue.pending,0);}finally{timers.forEach(clearInterval);}
});

test('overall safety limit still aborts a factory emitting new bytes forever',async()=>{
  const queue=new MediaEngineQueue(({onProgress,signal})=>new Promise(()=>{let bytes=0;const timer=setInterval(()=>onProgress({bytes:++bytes}),4);signal.addEventListener('abort',()=>clearInterval(timer));}),{factoryTimeout:20,factoryMaxTime:45,retryDelay:0});
  await assert.rejects(queue.run(()=>true),e=>e.decoderDiagnostic.code==='timeout');assert.equal(queue.pending,0);
});
