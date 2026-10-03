// Independent operation budgets. Ordinary queued/generating responses are success,
// not throttling. No credentials or signed media URLs are stored in these records.
export const PACING_VERSION=2;
export function pacingKey(platform,operation){return `request-pacing-v2:${platform}:${operation}`;}
export function submissionGap(settings={},profile={}){const base=Number(profile.submission?.cooldownSeconds)||61;return Math.max(base,Number(settings.submitGap)||base);}
export function pacingConfig(operation,settings={},profile={}){
  if(operation==='submit'){const base=submissionGap(settings,profile)*1000;return {base,step:10000,max:Math.max(base,181000),retry:5000};}
  return operation==='poll'?{base:10000,step:5000,max:60000,retry:5000}:{base:5000,step:5000,max:60000,retry:5000};
}
export function retryAfterTime(value,at=Date.now()){
  if(value===null||value===undefined||value==='')return 0;
  const text=String(value).trim();if(/^\d+(?:\.\d+)?$/.test(text))return at+Number(text)*1000;
  const date=Date.parse(text);return Number.isFinite(date)?Math.max(at,date):0;
}
export function platformPenalty(status,body={},retryAfter){
  const code=String(body?.code||body?.error?.code||body?.data?.code||'').toLowerCase();
  return status===429||status===529||[403,503].includes(status)&&(['rate_limit_exceeded','rate_limit','too_many_requests','throttled','slow_down','video_queue_full','overloaded'].includes(code)||!!retryAfterTime(retryAfter));
}
export function pacingInterval(state={},config){return Math.max(config.base,Math.min(config.max,Number(state.intervalMs)||config.base));}
export function pacingDue(state={},config,{notBefore=0,submissionFloor=0}={}){
  return Math.max(Number(state.notBefore)||0,notBefore,submissionFloor,state.lastSentAt?Number(state.lastSentAt)+pacingInterval(state,config):0);
}
export function pacingFeedback(state={},config,{status,body,retryAfter,ok,network=false,media=false}={},at=Date.now()){
  const next={...state,version:PACING_VERSION},penalty=platformPenalty(status,body,retryAfter),current=pacingInterval(state,config);
  next.lastFeedbackAt=at;next.lastStatus=status||null;
  if(penalty){next.intervalMs=Math.min(config.max,current+config.step);next.penaltyAt=at;next.notBefore=Math.max(Number(state.notBefore)||0,at+next.intervalMs,retryAfterTime(retryAfter,at));next.reason='platform';}
  else if(ok){next.intervalMs=Math.max(config.base,current-config.step);next.notBefore=media&&next.intervalMs===config.base?0:at+next.intervalMs;next.reason=next.intervalMs>config.base?'recovering':'normal';}
  else{next.intervalMs=current;next.notBefore=Math.max(Number(state.notBefore)||0,at+config.retry);next.reason=network?'network':'retry';}
  return next;
}
export function firstPollDelay(project,profileId){
  const durations=[];
  for(const job of project.jobs||[])if(job.profileId===profileId)for(const a of job.attempts||[]){
    const start=Date.parse(a.acceptedAt||a.submittedAt),end=Date.parse(a.remoteCompletedAt);
    if(end>start&&end-start<3600000)durations.push(end-start);
  }
  if(!durations.length)return 20000;
  const recent=durations.slice(-10).sort((a,b)=>a-b),median=recent[Math.floor(recent.length/2)];
  return Math.max(10000,Math.min(30000,Math.round(median*.6/1000)*1000));
}
