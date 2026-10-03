// Recovery is local/GET-only: never recreate a paid generation task.
export function canRecoverDownload(job){
  const a=job.attempts?.at(-1);
  return job.state==='blocked'&&!job.current&&!a?.resolved&&!!a?.url&&!a?.rawBlobKey&&!a?.rawPath&&a?.lastProblem?.operation==='media'&&!a?.downloadPermanent;
}
export function recoverDownloads(project){
  let count=0;
  for(const job of project.jobs||[]){const a=job.attempts?.at(-1);if(job.state==='download'&&a?.downloadRetryAt&&!a.downloadPacingVersion){if(!['http_429','http_503','http_529'].includes(a.lastProblem?.code))a.downloadRetryAt=Math.min(a.downloadRetryAt,Date.now()+5000);a.downloadPacingVersion=2;count++;}}
  for(const job of project.jobs||[])if(canRecoverDownload(job)){job.state='download';job.error=null;job.attempts.at(-1).downloadRecovery=true;count++;}
  return count;
}
export function downloadDelay(){return 5000;}
export function shouldRefreshLink(attempt,error,at=Date.now()){
  if(!attempt.videoId||at-Number(attempt.downloadLinkCheckedAt||0)<30000)return false;
  return [401,403,404,410].includes(error?.status)||(attempt.downloadFailures||0)>=2;
}
