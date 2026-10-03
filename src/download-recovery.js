// Recovery is local/GET-only: never recreate a paid generation task.
export function canRecoverDownload(job){
  const a=job.attempts?.at(-1);
  return job.state==='blocked'&&!job.current&&!a?.resolved&&!!a?.url&&!a?.rawBlobKey&&!a?.rawPath&&a?.lastProblem?.operation==='media'&&!a?.downloadPermanent;
}
export function recoverDownloads(project){
  let count=0;
  for(const job of project.jobs||[])if(canRecoverDownload(job)){job.state='download';job.error=null;job.attempts.at(-1).downloadRecovery=true;count++;}
  return count;
}
export function downloadDelay(failures){return Math.min(300,15*2**Math.min(5,Math.max(0,failures-1)))*1000;}
export function shouldRefreshLink(attempt,error,at=Date.now()){
  if(!attempt.videoId||at-Number(attempt.downloadLinkCheckedAt||0)<300000)return false;
  return [401,403,404,410].includes(error?.status)||(attempt.downloadFailures||0)>=2;
}
