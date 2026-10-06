import {remoteBlocks,unresolvedSubmission} from './queue-health.js';
export function reviewProblem(job,{activeUid,localChecks,revisionDraft}={}){
  if(!job?.current)return '当前视频尚未准备好，请先完成下载。';
  if(activeUid===job.uid||localChecks?.has(job.uid)||['submitting','unknown','queued','generating','download','checking','pending','deferred','invalid'].includes(job.state)||remoteBlocks(job)||unresolvedSubmission(job))return '此任务正在处理，请等当前视频处理完成后审核。';
  if(revisionDraft?.jobUid===job.uid)return '此任务正在修订，请先完成或取消修订。';
  return '';
}
export const reviewStamp=job=>JSON.stringify({uid:job.uid,state:job.state,review:job.review,error:job.error,updatedAt:job.updatedAt,current:job.current&&{number:job.current.number,sha256:job.current.sha256,path:job.current.path,qa:job.current.qa},attempts:job.attempts?.map(a=>({number:a.number,videoId:a.videoId,resolved:a.resolved,terminalConfirmed:a.terminalConfirmed}))});
export function reviewChanges(job,decision,reason='',at=new Date().toISOString()){
  if(!['approved','rejected'].includes(decision))throw Error('内容审核结论不正确。');
  if(!job.current)throw Error('当前视频尚未准备好，请先完成下载。');
  reason=String(reason).trim();if(decision==='rejected'&&!reason)throw Error('请填写内容不合格原因。');
  if(reason.length>4000)throw Error('不合格原因请控制在4000字内。');
  const qa=job.current.qa,technicalPassed=qa?.technical==='passed'&&qa.fullDecode==='passed'&&!(qa.fatal||[]).length;
  return {review:decision,reviewedAt:at,updatedAt:at,reviewVersion:{number:job.current.number,sha256:job.current.sha256},
    state:decision==='rejected'?'needs_redo':technicalPassed?'approved':qa?.technical==='failed'?'needs_redo':'blocked',
    error:decision==='rejected'?reason:technicalPassed?null:qa?.fatal?.join('；')||'内容已审核通过，技术校验尚未完成，程序需继续核验。'};
}
