import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateAutomaticQueue,inspectQueue,remoteBlocks,recoverLocalChecks} from '../src/queue-health.js';
import {makeProject,newJob,validateProjectFile} from '../src/core.js';
const base={id:'S03',episode:'EP01',prompt:'4秒，小熊挥手',seconds:4,aspect:'16:9',mode:'text',assetIds:[]};
test('saved S11 with legacy metadata timeout resumes original local check, without a new generation',()=>{
 const p=makeProject(),j=newJob({...base,id:'S11'});p.jobs=[j];j.state='blocked';j.error='无法读取媒体信息，请转换为常见格式后导入。';j.attempts=[{number:1,videoId:'original',rawPath:'raw/S11.mp4',rawSha256:'a'.repeat(64),downloadCompleteAt:new Date().toISOString(),lastProblem:{operation:'local',code:'Error',message:j.error}}];
 assert.equal(recoverLocalChecks(p),1);assert.equal(j.state,'checking');assert.equal(j.error,null);assert.equal(j.attempts.length,1);assert.equal(j.attempts[0].videoId,'original');assert.equal(remoteBlocks(j),false);assert.equal(inspectQueue(p).canStart,true);assert.equal(recoverLocalChecks(p),0);
});
test('legacy recovery does not override real QA failures, permissions, missing originals or resolved results',()=>{
 const saved={number:1,videoId:'original',rawPath:'raw/S11.mp4',rawSha256:'a'.repeat(64),downloadCompleteAt:new Date().toISOString(),lastProblem:{operation:'local',code:'Error',message:'无法读取媒体信息，请转换为常见格式后导入。'}};
 for(const change of [j=>j.attempts[0].lastProblem.message='实际画幅不符合16:9。',j=>j.attempts[0].lastProblem.message='本地文件权限被拒绝',j=>delete j.attempts[0].rawSha256,j=>j.current={},j=>j.attempts[0].resolved=true,j=>j.attempts[0].lastProblem.operation='submit']){
  const j=newJob(base);j.state='blocked';j.attempts=[structuredClone(saved)];change(j);assert.equal(recoverLocalChecks({jobs:[j]}),0);assert.equal(j.state,'blocked');
 }
});
test('download recovery backoff is not mislabeled as API rate limiting',()=>{
 const at=Date.now(),runner={running:true,activity:{kind:'recovery',waitUntil:at+76000}};
 const health=inspectQueue({jobs:[]},runner,at);assert.equal(health.code,'download-recovery');assert.match(health.message,/76 秒/);assert.doesNotMatch(health.message,/遵守请求间隔/);
 runner.activity.kind='waiting';assert.equal(inspectQueue({jobs:[]},runner,at).code,'waiting');
});
test('old approved novice intake resumes, while expert or explicit manual tasks retain their intent',()=>{
 const p=makeProject();p.jobs=[newJob({...base,experience:'easy',creationMode:'pavo'}),newJob({...base,id:'EXPERT',experience:'expert'}),newJob({...base,id:'MANUAL',experience:'easy',autoSubmit:false})];p.events=p.jobs.map(j=>({kind:'input_approved',jobId:j.id}));
 assert.equal(migrateAutomaticQueue(p),1);assert.equal(p.jobs[0].autoSubmit,true);assert.equal(p.jobs[1].autoSubmit,undefined);assert.equal(p.jobs[2].autoSubmit,false);assert.equal(migrateAutomaticQueue(p),0);assert.equal(inspectQueue(p).canStart,true);
 p.queueControl={paused:true};assert.equal(inspectQueue(p).code,'paused');
});
test('legacy migration clears only the exact queued Pavo draft, retaining a changed next draft',()=>{
 const p=makeProject(),j=newJob({...base,experience:'easy',creationMode:'pavo',studioId:'studio'});p.jobs=[j];p.events=[{kind:'input_approved',jobId:j.id}];p.studios=[{id:'studio',draft:{creationMode:'pavo',fields:{'pavo-prompt':j.prompt,'pavo-seconds':'12'},pavoSelected:[]}}];migrateAutomaticQueue(p);assert.equal(p.studios[0].draft.fields['pavo-prompt'],'');assert.equal(p.studios[0].draft.fields['pavo-seconds'],'12');
 delete j.autoSubmit;p.studios[0].draft.fields['pavo-prompt']='新镜头不同内容';migrateAutomaticQueue(p);assert.equal(p.studios[0].draft.fields['pavo-prompt'],'新镜头不同内容');
});
test('known original IDs and unknown POSTs block duplication; saved media releases remote slot',()=>{
 const p=makeProject(),j=newJob({...base,autoSubmit:true});p.jobs=[j];j.state='unknown';j.attempts=[{number:1,submittedAt:new Date().toISOString()}];assert.equal(inspectQueue(p).canStart,false);
 j.attempts[0].videoId='original';assert.equal(remoteBlocks(j),true);
 j.state='checking';Object.assign(j.attempts[0],{rawPath:'raw/S03.mp4',rawSha256:'a'.repeat(64),downloadCompleteAt:new Date().toISOString()});assert.equal(remoteBlocks(j),false);
 const next=newJob({...base,id:'S04',autoSubmit:true});p.jobs.push(next);assert.equal(inspectQueue(p).canStart,true);next.continuityFrom='S03';assert.equal(inspectQueue(p,{running:true,localChecks:new Map([[j.uid,{}]])}).code,'local');
 j.state='blocked';j.attempts[0].resolved=true;assert.equal(inspectQueue(p).code,'dependency');
});
test('project accepts concurrent saved local checks plus one remote task, rejects two unresolved remote requests',()=>{
 const p=makeProject(),local=newJob(base),remote=newJob({...base,id:'S04'});local.state='checking';local.attempts=[{number:1,videoId:'done',rawPath:'raw/S03.mp4',rawSha256:'a'.repeat(64),downloadCompleteAt:new Date().toISOString()}];remote.state='queued';remote.attempts=[{number:1,videoId:'next'}];p.jobs=[local,remote];assert.doesNotThrow(()=>validateProjectFile(p));delete local.attempts[0].downloadCompleteAt;assert.throws(()=>validateProjectFile(p),/多个未结束/);
});
test('restored local download resumes alone; a damaged local file cannot reclaim an already released remote slot',()=>{
 const p=makeProject(),j=newJob(base);p.jobs=[j];j.state='download';j.attempts=[{number:1,videoId:'original',rawPath:'raw/S03.mp4',rawSha256:'a'.repeat(64),downloadCompleteAt:new Date().toISOString()}];assert.equal(inspectQueue(p).canStart,true);
 Object.assign(j.attempts[0],{remoteReleasedAt:new Date().toISOString()});delete j.attempts[0].rawPath;delete j.attempts[0].rawSha256;delete j.attempts[0].downloadCompleteAt;assert.equal(remoteBlocks(j),false);assert.equal(inspectQueue(p).canStart,true);
 j.state='pending';j.attempts=[{number:1,submittedAt:new Date().toISOString()}];assert.equal(inspectQueue(p).code,'unconfirmed');j.attempts[0].rejectedBeforeCreation=true;assert.notEqual(inspectQueue(p).code,'unconfirmed');
});
