import test from 'node:test';
import assert from 'node:assert/strict';
import {makeProject,newJob,validateProjectFile} from '../src/core.js';
import {ensureStudios} from '../src/studio.js';
import {revisionProblem,revisionStamp,revisionDraft,revisedJob,revisionReplacements} from '../src/job-revision.js';
import {inspectQueue} from '../src/queue-health.js';
const base={id:'S26',episode:'EP01',prompt:'根据分镜，生成视频',seconds:12,mode:'reference',aspect:'16:9',assetIds:['original'],seed:12,dialogue:'角色：你好'};
test('repair reuses job identity, settings and historical submission snapshot',()=>{
  const j=newJob(base);j.state='invalid';j.reviewVersion={number:1,sha256:'a'.repeat(64)};j.reviewedAt=new Date().toISOString();j.attempts=[{number:1,submittedAt:new Date().toISOString(),rejectedBeforeCreation:true,snapshot:structuredClone(base)}];
  const history=JSON.stringify(j.attempts),fixed=revisedJob(j,{id:'NEW',uid:'NEW',episode:'OTHER',prompt:'时长4秒，调整动作',assetIds:['reuploaded']});
  assert.equal(revisionProblem(j),'');assert.equal(fixed.uid,j.uid);assert.equal(fixed.id,'S26');assert.equal(fixed.episode,'EP01');assert.equal(fixed.seed,12);assert.equal(fixed.seconds,4);assert.deepEqual(fixed.assetIds,['reuploaded']);assert.equal(JSON.stringify(j.attempts),history);
  assert.equal(fixed.reviewVersion,undefined);assert.equal(fixed.reviewedAt,undefined);assert.equal(j.reviewVersion.number,1);
});
test('unknown paid requests cannot be repaired into a new submission, even under a stale invalid label',()=>{
  for(const state of ['unknown','submitting','invalid','pending','failed']){const j=newJob(base);j.state=state;j.attempts=[{number:1,submittedAt:new Date().toISOString()}];assert.ok(revisionProblem(j));assert.throws(()=>revisedJob(j,{prompt:'new'}));}
  const j=newJob(base);j.state='invalid';j.attempts=[{number:1,videoId:'accepted',submittedAt:new Date().toISOString()}];assert.ok(revisionProblem(j));j.current={number:0};assert.ok(revisionProblem(j));j.current={number:1};assert.ok(revisionProblem(j));j.attempts[0].downloadCompleteAt=new Date().toISOString();assert.equal(revisionProblem(j),'');
});
test('draft restores Pavo prompt, model, dialogue and seed; keyframe and batch revisions use single-shot editor',()=>{
  const j=newJob({...base,creationMode:'pavo',profileId:'agnes-video-2.5-flash',sourceOriginalPrompt:'原始结构化提交'});const d=revisionDraft(j);
  assert.equal(d.creationMode,'pavo');assert.equal(d.fields['pavo-prompt'],'原始结构化提交');assert.equal(d.fields.seed,'12');assert.equal(d.fields.dialogue,base.dialogue);assert.deepEqual(d.pavoSelected,base.assetIds);
  assert.equal(revisionDraft({...j,mode:'keyframe',firstFrame:'first'}).fields['first-frame'],'first');assert.equal(revisionDraft({...j,mode:'keyframe'}).creationMode,'single');assert.equal(revisionDraft({...j,mode:'keyframe'}).fields['pavo-generation-mode'],'reference');assert.equal(revisionDraft({...j,creationMode:'batch'}).creationMode,'single');
});
test('same-name reupload changes only a unique selected reference and leaves ambiguous names to user selection',()=>{
  const assets=[{id:'old',name:'角色.png',kind:'image'},{id:'new',name:'角色.png',kind:'image'},{id:'other',name:'角色.png',kind:'image'},{id:'audio',name:'角色.png',kind:'audio'}];
  assert.deepEqual([...revisionReplacements(['old'],['new'],assets)],[['old','new']]);assert.equal(revisionReplacements(['old','other'],['new'],assets).size,0);assert.equal(revisionReplacements(['old'],['new','other'],assets).size,0);assert.equal(revisionReplacements(['old'],['audio'],assets).size,0);
});
test('changed prompt drops stale parsed duration and text-file provenance without rewriting history',()=>{
  const j=newJob({...base,prompt:'时长4秒，挥手',sourceOriginalPrompt:'old',textSources:[{field:'prompt'},{field:'dialogue'}],referenceReplacements:[{field:'prompt'}]});
  const fixed=revisedJob(j,{prompt:'新的场景',seconds:12});assert.equal(fixed.seconds,12);assert.equal(fixed.promptSeconds,undefined);assert.equal(fixed.sourceOriginalPrompt,undefined);assert.deepEqual(fixed.textSources,[{field:'dialogue'}]);assert.deepEqual(fixed.referenceReplacements,[]);
});
test('revision hold survives project validation and prevents auto scheduling while other jobs continue',()=>{
  const p=makeProject(),s=ensureStudios(p),j=newJob({...base,mode:'text',assetIds:[],autoSubmit:true,studioId:s.id});p.jobs=[j];
  p.revisionDraft={jobUid:j.uid,studioId:s.id,returnStudioId:s.id,stamp:revisionStamp(j),draft:revisionDraft(j)};
  assert.equal(validateProjectFile(structuredClone(p)).revisionDraft.jobUid,j.uid);assert.equal(inspectQueue(p).code,'editing');assert.equal(inspectQueue(p).canStart,false);
  p.jobs.push(newJob({...base,id:'S27',mode:'text',assetIds:[],autoSubmit:true}));assert.equal(inspectQueue(p).code,'resume');
  const bad=structuredClone(p);bad.revisionDraft.jobUid='absent';assert.throws(()=>validateProjectFile(bad));bad.revisionDraft=p.revisionDraft;bad.revisionDraft.draft.creationMode='batch';assert.throws(()=>validateProjectFile(bad));
});
