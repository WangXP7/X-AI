import {downloadSaved} from './queue-health.js';
import {MODEL_PROFILES,modelProfile} from './models.js';

// Successful creation starts a platform-wide cooldown. Polling and downloads do not reset it.
export function submissionCooldown(project,profileId,stored={},at=Date.now()){
  const profile=modelProfile(profileId),key=profile.platformId||profile.id;
  const seconds=Math.max(0,Number(profile.submission?.cooldownSeconds)||0);
  let acceptedAt=Number(stored[key])||0;
  for(const job of project.jobs||[]){
    for(const attempt of job.attempts||[]){
      if(!attempt.videoId)continue;
      const source=attempt.request?.model?MODEL_PROFILES.find(p=>p.model===attempt.request.model):MODEL_PROFILES.find(p=>p.id===(job.profileId||MODEL_PROFILES[0].id));
      if(!source||(source.platformId||source.id)!==key)continue;
      const timestamp=Date.parse(attempt.acceptedAt||attempt.submittedAt);
      if(Number.isFinite(timestamp))acceptedAt=Math.max(acceptedAt,timestamp);
    }
  }
  const until=acceptedAt?acceptedAt+seconds*1000:0;
  return {key,platformName:profile.platformName,seconds,acceptedAt,until,remaining:Math.max(0,Math.ceil((until-at)/1000))};
}
export function cooldownMessage(c){return `${c.platformName} 已接受上一次生成；平台要求成功提交后至少间隔 ${c.seconds} 秒。还需等待 ${c.remaining} 秒，原任务继续制作。`;}

export function pendingSubmission(project,job,runner={},stored={},rate={},at=Date.now()){
  const cooldown=submissionCooldown(project,job.profileId,stored,at),gap=Math.max(90,Number(project.settings?.gap)||90)*1000;
  const ahead=[];
  for(const previous of project.jobs||[]){
    if(previous.uid===job.uid)break;
    if(!downloadSaved(previous)&&!previous.attempts?.at(-1)?.remoteReleasedAt&&['pending','submitting','unknown','queued','generating','deferred','download','checking','blocked'].includes(previous.state))ahead.push(previous);
  }
  const until=Math.max(cooldown.until,Number(rate.last||0)+gap,Number(rate.notBefore)||0,runner.transport?.nextAt||0);
  const minimum=Math.max(0,Math.ceil((until-at)/1000));
  const remoteAhead=ahead.filter(j=>['submitting','queued','generating','unknown'].includes(j.state));
  const pendingAhead=ahead.filter(j=>['pending','deferred'].includes(j.state)).length;
  const remaining=minimum+pendingAhead*Math.ceil(gap/1000);
  const uncertain=remoteAhead.length>0||ahead.some(j=>['download','checking','blocked'].includes(j.state));
  return {position:ahead.length+1,remaining,uncertain,until,message:`预计等待 ${remaining} 秒`+(uncertain?'起，前序任务结束后提交':'后提交')};
}
