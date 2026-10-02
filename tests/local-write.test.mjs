import test from 'node:test';
import assert from 'node:assert/strict';
import {durableWrite} from '../src/local-write.js';
import {friendlyError} from '../src/core.js';

function fixture({failStage,failTimes=1,code='InvalidStateError',commitThenThrow=false,corrupt=false}={}){
  let bytes=new Blob(['before']),failures=0,opens=0,aborts=0;const delays=[],events=[],options=[];
  const fail=stage=>{if(stage===failStage&&failures++<failTimes)throw new DOMException('state changed',code);};
  const handle={getFileHandle:async()=>{opens++;return {getFile:async()=>bytes,createWritable:async option=>{options.push(option);fail('open');let pending;return {write:async value=>{fail('write');pending=value;},close:async()=>{if(commitThenThrow)bytes=pending;fail('close');bytes=corrupt?new Blob(['wrong']):pending;},abort:async()=>{aborts++;}};}};}};
  return {handle,delays,events,options,wait:async ms=>delays.push(ms),diagnostic:async r=>events.push(r),text:()=>bytes.text(),stats:()=>({opens,aborts})};
}
for(const stage of ['open','write','close'])test(`transient ${stage} failure reopens, backs off and verifies bytes`,async()=>{
  const f=fixture({failStage:stage,failTimes:2});await durableWrite(f.handle,'reference-mapping.json','素材映射',{wait:f.wait,diagnostic:f.diagnostic});
  assert.equal(await f.text(),'素材映射');assert.deepEqual(f.delays,[150,450]);assert.equal(f.events.at(-1).outcome,'recovered');assert.ok(f.options.every(o=>o.mode==='exclusive'));assert.ok(f.stats().opens>=4);
});
test('close reporting an error after committing is verified without another write',async()=>{
  const f=fixture({failStage:'close',commitThenThrow:true});await durableWrite(f.handle,'project.json','committed',{wait:f.wait,diagnostic:f.diagnostic});
  assert.equal(await f.text(),'committed');assert.equal(f.options.length,1);assert.equal(f.delays.length,0);assert.equal(f.events.at(-1).outcome,'verified-after-error');
});
test('persistent local failure is bounded and records exact stage and attempts',async()=>{
  const f=fixture({failStage:'write',failTimes:Infinity});await assert.rejects(durableWrite(f.handle,'reference-mapping.json','x',{wait:f.wait,diagnostic:f.diagnostic}),error=>{
    assert.equal(error.xaiStage,'write');assert.equal(error.xaiAttempts,5);assert.match(friendlyError(error),/已自动尝试 5 次/);assert.match(friendlyError(error),/reference-mapping.json/);return true;
  });assert.equal(f.options.length,5);assert.equal(f.stats().aborts,5);assert.deepEqual(f.delays,[150,450,1000,2000]);assert.equal(await f.text(),'before');
});
test('permission and disk-space failures are not blindly retried',async()=>{
  for(const code of ['NotAllowedError','QuotaExceededError']){const f=fixture({failStage:'open',code});await assert.rejects(durableWrite(f.handle,'project.json','x',{wait:f.wait,diagnostic:f.diagnostic}),error=>error.name===code);assert.equal(f.options.length,1);assert.deepEqual(f.delays,[]);}
});
test('wrong bytes after close cannot be reported as a successful save',async()=>{
  const f=fixture({corrupt:true});await assert.rejects(durableWrite(f.handle,'project.json','x',{wait:f.wait,diagnostic:f.diagnostic}),error=>error.name==='WriteVerificationError'&&error.xaiStage==='verify');assert.equal(f.options.length,1);
});
test('source bytes are materialized before opening and safe paths keep original names',async()=>{
  const f=fixture(),content=new Blob(['source']);let read=false;content.arrayBuffer=async()=>{read=true;return new TextEncoder().encode('source').buffer;};
  const getHandle=f.handle.getFileHandle;f.handle.getFileHandle=async(...args)=>{assert.equal(read,true);return getHandle(...args);};
  await durableWrite(f.handle,'A08_唐僧_05秒_参考V1.wav',content);assert.equal(await f.text(),'source');
  await assert.rejects(durableWrite(f.handle,'../source.wav','x'),/路径不安全/);assert.equal(f.options.length,1);
});
