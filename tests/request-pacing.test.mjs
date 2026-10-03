import test from 'node:test';
import assert from 'node:assert/strict';
import {pacingConfig,pacingFeedback,pacingDue,firstPollDelay,retryAfterTime,platformPenalty,submissionGap} from '../src/request-pacing.js';
const at=1000000,poll=pacingConfig('poll');
test('normal queue responses keep short cadence; legacy global gap has no effect',()=>{
 assert.equal(submissionGap({gap:90}),61);let s={};for(let i=0;i<20;i++)s=pacingFeedback(s,poll,{status:200,body:{status:'queued'},ok:true},at);
 assert.equal(s.intervalMs,10000);assert.equal(s.notBefore,at+10000);assert.equal(platformPenalty(401,{}),false);assert.equal(platformPenalty(500,{}),false);
 const n=pacingFeedback(s,poll,{network:true},at);assert.equal(n.intervalMs,10000);assert.equal(pacingFeedback({},poll,{network:true},at).notBefore,at+5000);
});
test('throttling increases in small steps and successful responses gradually restore baseline',()=>{
 let s={};const intervals=[];for(let i=0;i<3;i++){s=pacingFeedback(s,poll,{status:429},at);intervals.push(s.intervalMs);}assert.deepEqual(intervals,[15000,20000,25000]);
 for(let i=0;i<4;i++){s=pacingFeedback(s,poll,{ok:true},at);intervals.push(s.intervalMs);}assert.deepEqual(intervals.slice(3),[20000,15000,10000,10000]);
 for(let i=0;i<99;i++)s=pacingFeedback(s,poll,{status:503,body:{code:'video_queue_full'}},at);assert.equal(s.intervalMs,60000);
  const submit=pacingConfig('submit');assert.equal(pacingFeedback({},submit,{status:429},at).intervalMs,71000);
  const media=pacingConfig('media');let m={intervalMs:20000};m=pacingFeedback(m,media,{ok:true,media:true},at);assert.equal(m.intervalMs,15000);assert.equal(m.notBefore,at+15000);
  m=pacingFeedback(m,media,{ok:true,media:true},at);m=pacingFeedback(m,media,{ok:true,media:true},at);assert.equal(m.intervalMs,5000);assert.equal(m.notBefore,0);
});
test('server Retry-After seconds/date overrides the client cap and cannot be shortened',()=>{
 const s=pacingFeedback({},poll,{status:429,retryAfter:'180'},at);assert.equal(s.notBefore,at+180000);assert.equal(pacingDue(s,poll),at+180000);
 assert.equal(retryAfterTime(new Date(at+120000).toUTCString(),at),at+120000);assert.equal(retryAfterTime('invalid',at),0);
 assert.equal(platformPenalty(503,{},'45'),true);assert.equal(platformPenalty(403,{code:'rate_limit_exceeded'}),true);
});
test('first poll estimate is bounded and uses confirmed completion observations only',()=>{
 assert.equal(firstPollDelay({jobs:[]},'p'),20000);
 const project={jobs:[{profileId:'p',attempts:[{acceptedAt:new Date(at).toISOString(),remoteCompletedAt:new Date(at+20000).toISOString()}]}]};assert.equal(firstPollDelay(project,'p'),12000);
 project.jobs[0].attempts[0].remoteCompletedAt=new Date(at+600000).toISOString();assert.equal(firstPollDelay(project,'p'),30000);
 assert.equal(firstPollDelay(project,'other'),20000);
});
