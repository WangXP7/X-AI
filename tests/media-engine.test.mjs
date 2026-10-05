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
  const queue=new MediaEngineQueue(()=>({load:()=>fail?new Promise(()=>{}):Promise.resolve(),terminate(){}}),{loadTimeout:10});
  await assert.rejects(queue.run(()=>true),error=>error.name==='LocalCheckUnavailable'&&/超时/.test(error.message));fail=false;assert.equal(await queue.run(()=>true),true);
});
