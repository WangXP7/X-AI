import {promptSpec} from './prompt-spec.js';

// A missing file never proves that a paid creation request was rejected.
export function revisionProblem(job){
  const a=job.attempts?.at(-1);
  if(['unknown','submitting','queued','generating','download','checking'].includes(job.state))return '原任务仍在处理或提交结果待核实，请继续原任务。';
  if(a&&!a.resolved&&!a.terminalConfirmed){
    if(a.videoId&&(!job.current||job.current.number!==a.number||!a.remoteReleasedAt&&!a.downloadCompleteAt))return '原视频编号已返回，请先恢复原任务，避免重复生成。';
    if(a.submittedAt&&!a.videoId&&!a.rejectedBeforeCreation)return '原提交是否创建成功尚未确认，不能再次提交。';
  }
  if(job.state==='deferred'&&!a?.rejectedBeforeCreation)return '原请求仍在等待处理，请继续原任务。';
  if(job.state==='blocked'&&!job.current&&!a?.rejectedBeforeCreation)return '请先恢复原任务或本地校验。';
  return '';
}
export const revisionStamp=job=>JSON.stringify({uid:job.uid,id:job.id,state:job.state,updatedAt:job.updatedAt,prompt:job.prompt,dialogue:job.dialogue,seconds:job.seconds,aspect:job.aspect,mode:job.mode,profileId:job.profileId,seed:job.seed,assetIds:job.assetIds,firstFrame:job.firstFrame,lastFrame:job.lastFrame,continuityFrom:job.continuityFrom,current:job.current&&{number:job.current.number,sha256:job.current.sha256},attempts:job.attempts?.map(a=>({number:a.number,videoId:a.videoId,requestHash:a.requestHash,submittedAt:a.submittedAt,resolved:a.resolved,terminalConfirmed:a.terminalConfirmed,rejectedBeforeCreation:a.rejectedBeforeCreation}))});
export function revisedJob(job,changes){
  const problem=revisionProblem(job);if(problem)throw Error(problem);
  const fields=['prompt','dialogue','seconds','aspect','mode','profileId','seed','assetIds','firstFrame','lastFrame'];
  const candidate={...job,...Object.fromEntries(fields.filter(k=>Object.hasOwn(changes,k)).map(k=>[k,changes[k]]))};
  delete candidate.promptSeconds;delete candidate.sourceOriginalPrompt;
  if(candidate.prompt!==job.prompt){candidate.textSources=(job.textSources||[]).filter(s=>s.field!=='prompt');candidate.referenceReplacements=[];}
  return promptSpec(candidate);
}
export function revisionDraft(job){
  const mode=job.creationMode==='pavo'&&job.mode!=='keyframe'?'pavo':'single';
  const prompt=job.sourceOriginalPrompt||job.prompt;
  return {batchMode:false,creationMode:mode,pavoDefaultsVersion:'1.2.1',fields:{
    'shot-id':job.id,episode:job.episode,prompt,'pavo-prompt':prompt,
    'generation-mode':job.mode,'pavo-generation-mode':job.mode==='keyframe'?'reference':job.mode,seconds:String(job.seconds),'pavo-seconds':String(job.seconds),
    aspect:job.aspect,'pavo-aspect':job.aspect,dialogue:job.dialogue||'',seed:job.seed==null?'':String(job.seed),
    'first-frame':job.firstFrame||'','last-frame':job.lastFrame||'',
    'video-model':job.profileId||'agnes-video-2.5-flash','pavo-model':job.profileId||'agnes-video-2.5-flash'
  },selected:[...job.assetIds],pavoSelected:[...job.assetIds],batchSelected:[],continuity:false};
}
// Replace only an unambiguous selected name; submitted snapshots retain old IDs.
export function revisionReplacements(selected,uploaded,assets){
  const name=a=>a?.name.normalize('NFC').toLowerCase(),map=new Map();
  for(const id of selected){const old=assets.find(a=>a.id===id),matches=uploaded.map(i=>assets.find(a=>a.id===i)).filter(a=>a&&a.kind===old?.kind&&name(a)===name(old));
    if(matches.length===1&&selected.filter(i=>name(assets.find(a=>a.id===i))===name(old)).length===1)map.set(id,matches[0].id);
  }
  return map;
}
