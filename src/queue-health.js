// Scheduling intent is explicit; an old novice intake is not an expert draft.
export function migrateAutomaticQueue(project){
  let changed=0;
  for(const job of project.jobs||[]){
    const a=job.attempts?.at(-1),approved=project.events?.some(e=>e.jobId===job.id&&e.kind==='input_approved');
    if(job.autoSubmit===undefined&&job.state==='pending'&&(job.experience==='easy'||job.creationMode==='pavo')&&approved&&(!a||!a.submittedAt&&!a.videoId)){
      job.autoSubmit=true;changed++;
      const draft=project.studios?.find(s=>s.id===job.studioId)?.draft;
      if(job.creationMode==='pavo'&&draft?.creationMode==='pavo'&&typeof draft.fields?.['pavo-prompt']==='string'&&[job.prompt,job.sourceOriginalPrompt].includes(draft.fields['pavo-prompt'].trim())&&JSON.stringify([...(draft.pavoSelected||[])].sort())===JSON.stringify([...job.assetIds].sort())){
        draft.fields['pavo-prompt']='';draft.pavoSelected=[];
      }
    }
  }
  return changed;
}
export function downloadSaved(job){
  const a=job.attempts?.at(-1);
  return !!(a?.downloadCompleteAt&&a.rawPath&&a.rawSha256);
}
export function unresolvedSubmission(job){
  const a=job.attempts?.at(-1);
  return !a?.resolved&&!a?.terminalConfirmed&&!a?.videoId&&(['unknown','submitting'].includes(job.state)||job.state==='pending'&&!!a?.submittedAt&&!a?.rejectedBeforeCreation);
}
export function remoteBlocks(job){
  const a=job.attempts?.at(-1);
  if(a?.resolved||a?.terminalConfirmed||a?.remoteReleasedAt||downloadSaved(job))return false;
  if(a?.videoId)return true;
  return ['submitting','unknown','queued','generating','download','checking','deferred','blocked'].includes(job.state);
}
export function inspectQueue(project,runner={},at=Date.now()){
  const jobs=project.jobs||[],unknown=jobs.find(unresolvedSubmission),paused=!!(runner.pauseNew||project.queueControl?.paused);
  const pending=jobs.find(j=>j.state==='pending'&&j.autoSubmit),remote=jobs.find(remoteBlocks);
  if(unknown)return {code:'unconfirmed',message:`${unknown.id} 的提交回执尚未确认，已保留原请求，防止重复生成`,canStart:false};
  if(remote?.state==='blocked')return {code:'blocked',message:`${remote.id} 尚未释放原任务：${remote.error||'正在核验恢复条件'}`,canStart:false};
  if(runner.running){
    const activity=runner.activity||{},waitUntil=Math.max(activity.waitUntil||0,activity.kind==='waiting'?runner.transport?.nextAt||0:0);
    if(activity.kind==='recovery')return {code:'download-recovery',message:waitUntil>at?`原视频下载重试将在 ${Math.ceil((waitUntil-at)/1000)} 秒后继续；已保存的原片会优先恢复`:'正在恢复原片下载，保留原任务编号',canStart:false};
    if(waitUntil>at)return {code:'waiting',message:`${activity.label||'遵守请求间隔'}，${Math.ceil((waitUntil-at)/1000)} 秒后自动继续`,canStart:false};
    if(runner.localChecks?.size&&!runner.activeUid)return {code:'local',message:'原片已保存，正在后台技术校验；下一镜无需等待内容审核',canStart:false};
    const age=activity.updatedAt?at-activity.updatedAt:0;
    return {code:age>45000?'slow':'running',message:age>45000?`当前步骤已等待 ${Math.floor(age/1000)} 秒，超时保护仍在运行`:'调度器正在处理，进度正常跟踪',canStart:false};
  }
  if(remote&&!(paused&&remote.state==='deferred'&&!remote.attempts?.at(-1)?.videoId))return {code:'resume',message:`正在自动恢复 ${remote.id} 的原任务处理`,canStart:true};
  const local=jobs.find(j=>j.state==='checking'&&downloadSaved(j)||j.state==='download'&&(downloadSaved(j)||j.attempts?.at(-1)?.remoteReleasedAt));
  if(local)return {code:'resume',message:`正在恢复 ${local.id} 的原片下载和后台校验`,canStart:true};
  if(paused)return {code:'paused',message:'你已暂停新提交，点击“开始 / 继续队列”后恢复',canStart:false};
  if(pending?.continuityFrom&&!jobs.some(j=>j.id===pending.continuityFrom&&['ready','approved'].includes(j.state)&&j.current?.lastFrameKey))return {code:'dependency',message:`${pending.id} 正等待 ${pending.continuityFrom} 的技术校验和末帧，完成后自动接续`,canStart:false};
  if(pending)return {code:'resume',message:`正在自动接续 ${pending.id}，无需等待前片内容审核`,canStart:true};
  if(jobs.some(j=>j.state==='pending'))return {code:'manual',message:'专家任务等待开始，点击“开始 / 继续队列”即可',canStart:false};
  return {code:'idle',message:'队列已处理完毕；内容审核不阻塞新镜生成',canStart:false};
}
