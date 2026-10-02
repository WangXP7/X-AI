import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_PROFILES,modelCapability,modelOptionLabel,requestDurationValid} from '../src/models.js';
import {validateJob,newJob} from '../src/core.js';
test('duration validation follows profile and mode instead of a global 12-second constant',()=>{
  const profile={id:'synthetic-provider',platformName:'测试平台',modelLabel:'测试模型',model:'test',resolution:'1080P',modes:{text:{minSeconds:3,maxSeconds:20,step:1},reference:{minSeconds:3,maxSeconds:8,step:1}},references:{maxImages:2,maxAudio:1,minAudioSeconds:2,maxAudioSeconds:8}};
  MODEL_PROFILES.push(profile);
  try{assert.equal(requestDurationValid(18,profile.id,'text'),true);assert.equal(requestDurationValid(18,profile.id,'reference'),false);assert.equal(modelCapability(profile.id,'reference').maxSeconds,8);assert.match(modelOptionLabel(profile.id,'text'),/测试平台.*1080P.*20 秒/);
    const j=newJob({id:'S',episode:'E',seconds:18,prompt:'视频',mode:'text',profileId:profile.id,aspect:'16:9',assetIds:[]});assert.equal(validateJob(j,[]).errors.length,0);
    j.mode='reference';assert.match(validateJob(j,[]).errors.join(''),/测试平台.*3–8秒/);
  }finally{MODEL_PROFILES.pop();}
});
test('unconfigured provider is rejected rather than using Agnes silently',()=>{assert.throws(()=>modelCapability('not-configured'),/尚未配置/);});
