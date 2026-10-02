import test from 'node:test';
import assert from 'node:assert/strict';
import {queueProgress,reportedProgress} from '../src/queue-progress.js';
const at=Date.parse('2026-10-02T12:00:00Z');
const job={uid:'known',id:'S01',state:'generating',progress:45,progressKnown:true,attempts:[{videoId:'keep-me',submittedAt:new Date(at-120000).toISOString(),polledAt:new Date(at-10000).toISOString()}]};
test('overall progress counts actual finished jobs independently of current task percentage',()=>{
  const p=queueProgress({jobs:[job,{uid:'ready',state:'ready'},{uid:'pending',state:'pending'},{uid:'blocked',state:'blocked'}]},{running:true,activeUid:'known'},at);
  assert.equal(p.ready,1);assert.equal(p.overall,25);assert.equal(p.percent,45);assert.equal(p.stage,2);assert.equal(p.attention,1);assert.match(p.updated,/10 秒前/);
});
test('waiting countdown and request elapsed time are live factual values',()=>{
  const runner={running:true,activeUid:'known',activity:{kind:'waiting',waitUntil:at+15000},transport:{nextAt:at+15000}};
  assert.equal(queueProgress({jobs:[job]},runner,at).seconds,15);assert.equal(queueProgress({jobs:[job]},runner,at+2000).seconds,13);
  runner.activity={kind:'requesting',label:'正在查询服务端状态',startedAt:at-8000};const p=queueProgress({jobs:[job]},runner,at);assert.match(p.detail,/8 秒/);assert.equal(p.percent,null);assert.equal(p.indeterminate,true);
});
test('unknown percentages remain indeterminate instead of inventing smooth progress',()=>{
  for(const value of [undefined,null,'',NaN,Infinity,-1,101,'unknown',{},true])assert.equal(reportedProgress(value),null);
  assert.equal(reportedProgress('35%'),35);assert.equal(reportedProgress(0),0);
  const p=queueProgress({jobs:[{...job,progressKnown:false}]},{running:true},at);assert.equal(p.percent,null);assert.equal(p.indeterminate,true);
});
test('download and local stage progress are actual partial-operation percentages',()=>{
  const runner={running:true,activeUid:'known',activity:{kind:'download',bytes:5000000,total:20000000}};
  const p=queueProgress({jobs:[{...job,state:'download'}]},runner,at);assert.equal(p.percent,25);assert.match(p.detail,/5.00 MB \/ 20.00 MB/);
  runner.activity.total=0;assert.equal(queueProgress({jobs:[job]},runner,at).percent,null);
  runner.activity={kind:'check',label:'抽帧',percent:60};assert.equal(queueProgress({jobs:[{...job,state:'checking'}]},runner,at).percent,60);
});
test('paused tracking and unknown submission do not masquerade as active generation',()=>{
  const p=queueProgress({jobs:[{...job,state:'unknown',progressKnown:false,error:'请核实原编号'}]}, {},at);assert.equal(p.busy,false);assert.equal(p.indeterminate,false);assert.match(p.detail,/跟踪已停止/);assert.equal(p.warning,'请核实原编号');
});
