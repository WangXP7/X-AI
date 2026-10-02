import assert from 'node:assert/strict';
import test from 'node:test';
import {promptSpec,durationQA,reconcileDurationQA} from '../src/prompt-spec.js';
import {newJob,validateJob,parseBatch,makeProject} from '../src/core.js';
test('prompt duration wins over UI and resolved CSV, without retroactively modifying attempts',()=>{
  const raw=JSON.stringify({id:'A01',seconds:7,video_prompt:'小熊走进森林',dialogue_suggestion:'小熊：你好。'});
  const j=newJob({id:'S01',episode:'EP01',prompt:raw,seconds:12,mode:'text',aspect:'16:9',assetIds:[],dialogue:''});
  assert.equal(j.seconds,7);assert.equal(j.prompt,'小熊走进森林');assert.equal(j.dialogue,'小熊：你好。');assert.equal(j.sourceOriginalPrompt,raw);
  const [s]=parseBatch('镜号,时长秒,提示词\nA01,12,视频时长：6秒；小熊跳舞',{id:'S',episode:'EP01',seconds:12,aspect:'16:9',mode:'text',assetIds:[]},[]);
  assert.equal(s.seconds,6);assert.equal(s.durationSource,'提示词正文');assert.equal(newJob(s).durationSource,'提示词正文');
});
test('only explicit total length declares timing; ambiguous and impossible requests stay actionable',()=>{
  assert.equal(promptSpec({prompt:'等待7秒后转头',seconds:12}).seconds,12);
  assert.equal(promptSpec({prompt:'制作一段7秒视频，持续推镜',seconds:12}).seconds,7);
  assert.throws(()=>promptSpec({prompt:'视频时长7秒，总时长8秒',seconds:12}),/多个不同/);
  const j=newJob({id:'S',episode:'E',prompt:'总时长20秒，跳舞',seconds:12,aspect:'16:9',mode:'text',assetIds:[]});
  assert.equal(j.seconds,20);assert.match(validateJob(j,[]).errors.join(''),/接口只接受/);
  assert.equal(promptSpec({prompt:'{"seconds":7,"video_prompt":"跳舞"}\n\n【X-AI运行约束】\n旧约束',seconds:12}).seconds,7);
});
test('valid returned video longer than request and 12 seconds passes duration check unchanged',()=>{
  assert.deepEqual(durationQA(12.256,12),{fatal:[],warnings:[]});assert.deepEqual(durationQA(18,7),{fatal:[],warnings:[]});
  assert.equal(durationQA(0,12).fatal.length,1);assert.equal(durationQA(NaN,12).fatal.length,1);assert.equal(durationQA(6,12).warnings.length,1);
});
test('old duration-only failure migrates after full decoding; other faults and review rejection remain',()=>{
  const p=makeProject(),qa={duration:12.256,fullDecode:'passed',technical:'failed',fatal:['实际12.26秒，与计划12秒不符或超过12秒。']};
  p.jobs=[{id:'S',state:'needs_redo',review:'pending',seconds:12,prompt:'original JSON',attempts:[{request:{seconds:'12'},qa:structuredClone(qa)}],current:{qa:structuredClone(qa)}}];
  const input=JSON.stringify(p.jobs[0].attempts[0].request);assert.equal(reconcileDurationQA(p),2);assert.equal(p.jobs[0].state,'ready');assert.equal(p.jobs[0].review,'pending');assert.equal(JSON.stringify(p.jobs[0].attempts[0].request),input);
  p.jobs[0].state='needs_redo';p.jobs[0].review='rejected';p.jobs[0].error='角色错误';reconcileDurationQA(p);assert.equal(p.jobs[0].state,'needs_redo');
  p.jobs[0].current.qa={...qa,fatal:[...qa.fatal,'完整解码未通过。']};reconcileDurationQA(p);assert.equal(p.jobs[0].current.qa.technical,'failed');
});
