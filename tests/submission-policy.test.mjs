import assert from 'node:assert/strict';
import test from 'node:test';
import {MODEL_PROFILES,DEFAULT_PROFILE_ID} from '../src/models.js';
import {submissionCooldown} from '../src/submission-policy.js';
const accepted=Date.parse('2026-10-03T08:00:00Z');
const job={profileId:DEFAULT_PROFILE_ID,attempts:[{videoId:'synthetic',acceptedAt:new Date(accepted).toISOString(),submittedAt:new Date(accepted-5000).toISOString(),polledAt:new Date(accepted+50000).toISOString()}]};
test('successful platform receipt starts exact 60s window; polls do not reset it',()=>{
 const p={jobs:[job]};assert.equal(submissionCooldown(p,DEFAULT_PROFILE_ID,{},accepted).remaining,60);assert.equal(submissionCooldown(p,DEFAULT_PROFILE_ID,{},accepted+59001).remaining,1);assert.equal(submissionCooldown(p,DEFAULT_PROFILE_ID,{},accepted+60000).remaining,0);
 assert.equal(submissionCooldown({jobs:[{attempts:[{submittedAt:new Date(accepted).toISOString()}]}]},DEFAULT_PROFILE_ID,{},accepted).remaining,0);
});
test('persisted cooldown survives project change; another platform keeps its own policy',()=>{
 assert.equal(submissionCooldown({jobs:[]},DEFAULT_PROFILE_ID,{agnes:accepted},accepted+30000).remaining,30);
 MODEL_PROFILES.push({id:'other-test',platformId:'other',platformName:'Other',submission:{cooldownSeconds:10}});
 try{assert.equal(submissionCooldown({jobs:[job]},'other-test',{agnes:accepted},accepted).remaining,0);assert.equal(submissionCooldown({jobs:[]},'other-test',{other:accepted},accepted+9000).remaining,1);}finally{MODEL_PROFILES.pop();}
});
test('legacy accepted task uses submittedAt; latest same-platform model receipt wins',()=>{
 const p={jobs:[{attempts:[{videoId:'old',submittedAt:new Date(accepted).toISOString(),request:{model:MODEL_PROFILES[0].model}}]}]};assert.equal(submissionCooldown(p,DEFAULT_PROFILE_ID,{},accepted+1000).remaining,59);
 p.jobs.push(job);assert.equal(submissionCooldown(p,DEFAULT_PROFILE_ID,{agnes:accepted+5000},accepted+10000).remaining,55);
});
