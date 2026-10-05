import {ORIGINS,DIMENSIONS,now,uid,sha256,redact,nested,classifyHTTP,friendlyError,validateJob,requestPrompt,recordEvent} from './core.js';
import {promptSpec} from './prompt-spec.js';
import {MODEL_PROFILES,modelProfile} from './models.js';
import {submissionCooldown,cooldownMessage} from './submission-policy.js';
import {get,put,blob,storeBlob,saveProject,writeFile,permitted,reportMarkdown,readAsset,readFile} from './storage.js';
import {dataURL,inspectVideo,concatenate,videoMetadata,deepCheck} from './media.js';
import {reportedProgress} from './queue-progress.js';
import {ConnectionError,networkRecord} from './network.js';
import {recoverDownloads,downloadDelay,shouldRefreshLink} from './download-recovery.js';
import {downloadSaved,remoteBlocks,unresolvedSubmission} from './queue-health.js';
import {savedDownload,rawDownloadPath,writeDownloadReceipt} from './download-checkpoint.js';
import {APP_VERSION} from './runtime-version.js';
import {AutomaticMediaRelay,relayDiagnostic} from './media-relay.js';
import {pacingKey,pacingConfig,pacingDue,pacingFeedback,platformPenalty,firstPollDelay} from './request-pacing.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class APIError extends Error{constructor(status,body,retryAfter){super(`接口返回${status}：${String(nested(body,['message','detail'])||'请求未成功').slice(0,140)}`);this.status=status;this.body=body;this.retryAfter=retryAfter;}}
export class MissingCredential extends Error{constructor(){super('生成密钥未启用，启用后自动继续原任务。');this.name='MissingCredential';}}
export class Transport {
  constructor(context,onActivity=()=>{}){this.context=context;this.onActivity=onActivity;this.key='';this.bridgeToken='';this.nextAt=0;this.lastResponseAt=null;this.mediaRelay=new AutomaticMediaRelay();}
  async api(route,payload,beforeSend,{notBefore=0}={}){
    if(!this.key)throw new MissingCredential();const {project}=this.context();const settings=project.settings;
    if(!ORIGINS.includes(settings.origin)||!route.startsWith('/')||route.startsWith('//'))throw Error('接口地址不受信任。');
    const operation=payload?'submit':route.startsWith('/v1/models')?'models':'poll',model=payload?.model||new URL(route,settings.origin).searchParams.get('model_name');
    const profile=MODEL_PROFILES.find(p=>p.model===model)||modelProfile(),key=pacingKey(profile.platformId||profile.id,operation),config=pacingConfig(operation,settings,profile);
    // Separate locks prevent a POST cooldown from holding up status queries.
    return navigator.locks.request(key,async()=>{
      let rate=await get('state',key)||{};const cooldown=payload?submissionCooldown(project,profile.id,await get('state','submission-cooldowns')||{}):null;
      const sendFloor=payload?Math.max(0,...project.jobs.flatMap(j=>j.attempts.filter(a=>!a.request?.model||a.request.model===profile.model).map(a=>Date.parse(a.sentAt||a.submittedAt)||0))):0;
      const due=pacingDue(rate,config,{notBefore,submissionFloor:Math.max(cooldown?.until||0,sendFloor?sendFloor+config.base:0)});this.nextAt=due;
      if(Date.now()<due)this.onActivity({kind:'waiting',operation,label:rate.reason==='platform'?'平台限流，等待恢复':operation==='submit'?'等待生成提交间隔':'等待下次状态查询',waitUntil:due});while(Date.now()<due)await sleep(Math.min(1000,due-Date.now()));
      // Snapshot credentials before the send checkpoint. A change while an
      // existing request is in flight affects only later requests.
      const credential=this.key,bridgeToken=this.bridgeToken;
      if(!credential)throw new MissingCredential();
      const bridge=settings.connection==='bridge';if(bridge&&!bridgeToken)throw Error('请填写本机连接器配对码。');
      if(beforeSend)await beforeSend();
      rate={...rate,version:2,lastSentAt:Date.now()};await put('state',key,rate);
      const url=bridge?'http://127.0.0.1:4174/api'+route:settings.origin+route;
      const headers={'Authorization':'Bearer '+credential,'Accept':'application/json'};
      if(payload)headers['Content-Type']='application/json';if(bridge){headers['X-XAI-Token']=bridgeToken;headers['X-XAI-Origin']=settings.origin;}
      this.onActivity({kind:'requesting',label:payload?'正在提交素材与任务':'正在查询服务端状态'});
      try{const response=await fetch(url,{method:payload?'POST':'GET',headers,body:payload?JSON.stringify(payload):undefined,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(180000)});
        const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{if(response.ok)throw Error('接口未返回JSON，保留当前任务，请检查连接。');body={message:'接口未返回JSON'};}
        this.lastResponseAt=Date.now();const retryAfter=response.headers.get('Retry-After');rate=pacingFeedback(rate,config,{status:response.status,body,retryAfter,ok:response.ok});await put('state',key,rate);this.nextAt=rate.notBefore;
        if(!response.ok){const error=new APIError(response.status,redact(body),retryAfter);error.credentialChanged=credential!==this.key;throw error;}return body;
      }catch(error){if(error instanceof TypeError||['TimeoutError','AbortError'].includes(error?.name)){await put('state',key,pacingFeedback(rate,config,{network:true}));throw new ConnectionError(operation,bridge?'bridge':'direct',error);}throw error;}finally{this.onActivity({kind:'idle'});}
    });
  }
  async media(url){
    return navigator.locks.request('x-ai-media-download',()=>this.downloadMedia(url));
  }
  async downloadMedia(url){
    let parsed;try{parsed=new URL(url);}catch{throw new ConnectionError('media','local',{status:400,permanent:true});}
    if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new ConnectionError('media','local',{status:400,permanent:true});
    const {project}=this.context(),bridge=project.settings.connection==='bridge';
    const key=pacingKey(parsed.hostname,'media'),config=pacingConfig('media');let rate=await get('state',key)||{};
    if(rate.notBefore>Date.now()){this.onActivity({kind:'waiting',operation:'media',label:rate.reason==='platform'?'下载通道限流，等待恢复':'等待重试下载',waitUntil:rate.notBefore});while(rate.notBefore>Date.now())await sleep(Math.min(1000,rate.notBefore-Date.now()));}
    const local=['127.0.0.1','localhost'].includes(location.hostname)&&location.protocol==='http:'&&parsed.hostname==='cos-platform-outputs.agnes-ai.cn';
    this.onActivity({kind:'download',label:'正在检查视频下载通道',bytes:0,total:0});
    let automatic=await this.mediaRelay.discover(url);
    const channels=[...(local?['local']:[]),...(automatic.state==='ready'?['automatic']:[]),...(bridge&&this.bridgeToken?['bridge']:[]),'direct'];let primaryError;
    const diagnostic=this.mediaDiagnostic={version:APP_VERSION,pageOrigin:location.origin,localEligible:local,relay:relayDiagnostic(automatic),startedAt:now(),channels:[]};
    for(let round=0;round<3;round++){
      for(const channel of channels){
        let reader;const started=Date.now();
        try{
          if(channel==='automatic'){
            automatic=await this.mediaRelay.discover(url);diagnostic.relay=relayDiagnostic(automatic);
            if(automatic.state!=='ready')throw new ConnectionError('media',channel,new TypeError('Media relay unavailable'));
          }
          const label=(['local','automatic'].includes(channel)?'正在通过本机取回原视频':channel==='bridge'?'正在通过已连接通道取回原视频':'正在直接下载原视频')+(round?` · 第 ${round+1} 次`:'');
          this.onActivity({kind:'download',label,bytes:0,total:0});
          const endpoint=channel==='automatic'?automatic.endpoint:channel==='bridge'?'http://127.0.0.1:4174/media':channel==='local'?new URL('../__xai_media',import.meta.url):url;
          const res=await fetch(endpoint,{method:channel==='direct'?'GET':'POST',headers:channel==='automatic'?{'Content-Type':'application/json','X-XAI-Media-Token':automatic.token}:channel==='bridge'?{'Content-Type':'application/json','X-XAI-Token':this.bridgeToken}:channel==='local'?{'Content-Type':'application/json'}:{},body:channel==='direct'?undefined:JSON.stringify({url}),credentials:'omit',cache:'no-store',redirect:channel==='direct'?'follow':'error',signal:AbortSignal.timeout(180000)});
          if(!res.ok){let info;if(channel!=='direct')try{info=await res.json();}catch{}
            if(channel==='automatic'&&info?.code==='media_session_required'){this.mediaRelay.failed();throw new ConnectionError('media',channel,{name:'MediaSessionExpired'});}
            const status=info?.upstreamStatus||res.status,retryAfter=info?.retryAfter||res.headers.get('Retry-After');const failure=new ConnectionError('media',channel,{status,permanent:info?.permanent});if(platformPenalty(status,info,retryAfter)){rate=pacingFeedback(rate,config,{status,body:info,retryAfter});await put('state',key,rate);failure.retryAt=rate.notBefore;failure.penalty=true;}throw failure;}
          const type=res.headers.get('content-type')||'',total=Number(res.headers.get('content-length')||0);
          if(type&&!/^(video\/|application\/octet-stream)/i.test(type))throw new ConnectionError('media',channel,{status:415});
          if(total>512_000_000)throw new ConnectionError('media',channel,{status:413,permanent:true});
          if(!res.body)throw new ConnectionError('media',channel,{name:'EmptyDownload'});
          reader=res.body.getReader();const parts=[];let length=0;
          while(true){let chunk;try{chunk=await reader.read();}catch(error){throw new ConnectionError('media',channel,error);}if(chunk.done)break;length+=chunk.value.length;if(length>512_000_000)throw new ConnectionError('media',channel,{status:413,permanent:true});parts.push(chunk.value);this.onActivity({kind:'download',label,bytes:length,total});}
          if(!length||total&&length!==total)throw new ConnectionError('media',channel,{name:'IncompleteDownload'});
          const file=new Blob(parts,{type:'video/mp4'}),signature=new TextDecoder('latin1').decode(await file.slice(0,64).arrayBuffer());
          if(file.size<1024||!signature.includes('ftyp'))throw new ConnectionError('media',channel,{name:'InvalidMedia'});
          diagnostic.channels.push({channel,round:round+1,result:'success',bytes:file.size,elapsedMs:Date.now()-started});diagnostic.completedAt=now();file.downloadDiagnostic=diagnostic;
          await put('state',key,pacingFeedback(rate,config,{ok:true,media:true}));
          return file;
        }catch(error){
          const failure=error instanceof ConnectionError?error:new ConnectionError('media',channel,error);
          diagnostic.channels.push({channel,round:round+1,result:'failed',code:failure.code,status:failure.status,elapsedMs:Date.now()-started});
          failure.diagnostic=diagnostic;
          if(!primaryError||[401,403,404,410].includes(failure.status))primaryError=failure;
          // Never combine partial bodies from different attempts or signed URLs.
          try{await reader?.cancel();}catch{}try{reader?.releaseLock();}catch{}
          if(failure.permanent||failure.penalty)throw failure;
          if(channel==='automatic'&&failure.code==='fetch_unreadable')this.mediaRelay.failed();
          this.onActivity({kind:'download',label:'正在自动恢复下载',bytes:0,total:0});
        }
      }
      // CORS / missing local service cannot improve by repeating the identical
      // unreadable request three times. Probe again with the 30-second self-check.
      if(location.protocol==='https:'&&diagnostic.channels.filter(x=>x.round===round+1).every(x=>x.code==='fetch_unreadable')){
        const failure=new ConnectionError('media','automatic',{name:'MediaChannelUnavailable'});
        failure.waitingFor=automatic.state==='permission-denied'?'browser-permission':automatic.reason==='session_unreachable'?'local-service':'download-channel';failure.retryAt=Date.now()+30000;failure.diagnostic=diagnostic;throw failure;
      }
      if(round<2)await sleep(1000*2**(round+1));
    }
    primaryError.diagnostic=diagnostic;throw primaryError;
  }

}
export class Runner {
  constructor(context,onChange,onMessage){this.localChecks=new Map();this.localActivity={kind:'idle'};this.starting=false;this.allowedUids=new Set();this.beforeNew=async()=>{};this.context=context;this.onChange=onChange;this.message=onMessage;this.running=false;this.pauseNew=false;this.refreshing=false;this.assembling=false;this.activeUid=null;this.activity={kind:'idle'};this.onActivity=()=>{};this.transport=new Transport(context,value=>this.setActivity(value));}
  setActivity(value){const same=this.activity.kind===value.kind&&this.activity.label===value.label;this.activity={...value,startedAt:same?this.activity.startedAt:Date.now(),updatedAt:Date.now()};this.onActivity();}
  async refreshStatus(){
    if(this.running)return {mode:'live',message:'页面状态已刷新；正在运行的队列会按原间隔查询。'};
    if(this.refreshPromise)return this.refreshPromise;
    if(this.assembling)return {mode:'local',message:'已刷新本地拼接进度。'};
    this.refreshing=true;this.setActivity({kind:'refresh',label:'正在刷新任务状态'});
    this.refreshPromise=(async()=>{try{return await navigator.locks.request('x-ai-production-runner',{ifAvailable:true},async lock=>{
      if(!lock)return {mode:'locked',message:'另一个窗口正在处理任务，已刷新当前显示。'};
      const {project,folder}=this.context();const job=project.jobs.find(j=>['queued','generating','blocked','pending'].includes(j.state)&&j.attempts.at(-1)?.videoId&&!j.attempts.at(-1).terminalConfirmed&&!j.attempts.at(-1).resolved&&!j.attempts.at(-1).url);
      if(!job)return {mode:'local',message:project.jobs.some(j=>['unknown','submitting'].includes(j.state))?'页面已刷新；提交结果待核实，请先绑定原 video_id。':'页面已刷新，暂无需要查询的已知任务。'};
      if(!this.transport.key)throw Error('刷新服务端状态需要先启用密钥。');if(!await permitted(folder))throw Error('请先重新授权本地文件夹，再刷新服务端状态。');
      this.activeUid=job.uid;job.state='queued';await this.step(job);return {mode:'queried',message:job.error?'已查询原任务：'+job.error:'已查询 '+job.id+' 的原任务状态。'};
    });}finally{this.refreshing=false;this.activeUid=null;this.setActivity({kind:'idle'});this.refreshPromise=null;this.onChange();}})();return this.refreshPromise;
  }
  async persist(disk=false){const {project,folder}=this.context();await saveProject(project,folder,{requireDisk:disk});if(folder&&await permitted(folder))await writeFile(folder,'X-AI_制作过程与结果.md',reportMarkdown(project));this.onChange();}
  event(kind,msg,id){recordEvent(this.context().project,kind,msg,id);}
  async setPaused(paused){
    const p=this.context().project;p.queueControl={...p.queueControl,paused,updatedAt:now()};this.pauseNew=paused;await this.persist();
  }
  async credentialsReady(){
    if(!this.transport.key)return;
    let changed=false;
    for(const job of this.context().project.jobs){const a=job.attempts.at(-1);
      if(job.state==='blocked'&&a?.pollCredentialRejected&&a.videoId&&!a.url&&!a.resolved&&!a.terminalConfirmed){
        delete a.pollCredentialRejected;job.state='queued';job.error=null;changed=true;
      }
    }
    if(changed){this.event('credentials_resumed','密钥已启用，继续查询原任务编号');await this.persist();}
  }
  setLocalActivity(job,value){this.localActivity={...value,uid:job.uid,updatedAt:Date.now()};this.onActivity();}
  launchLocalCheck(job,file){
    if(this.localChecks.has(job.uid)||job.attempts.at(-1)?.localCheckRetryAt>Date.now())return;
    const task=(async()=>{
      try{
        if(job.state==='download'){await this.step(job);return;}
        if(!file){const a=job.attempts.at(-1);try{file=await blob(a.rawBlobKey);}catch{file=await readFile(this.context().folder,a.rawPath);}}
        await this.acceptFile(job,file,job.attempts.at(-1),{autoDownload:true,background:true});
      }catch(error){
        const a=job.attempts.at(-1);a.lastProblem=networkRecord(error)||{at:now(),operation:'local',code:error.name,message:friendlyError(error)};
        if(error.name==='LocalCheckUnavailable'){a.localCheckFailures=(a.localCheckFailures||0)+1;a.localCheckRetryAt=Date.now()+30000;job.state='checking';job.error=null;}
        else if(error instanceof ConnectionError&&error.operation==='media'){a.downloadRecovery=true;a.downloadRetryAt=Date.now()+downloadDelay((a.downloadFailures=(a.downloadFailures||0)+1));job.state='download';job.error=null;}
        else{job.state='blocked';job.error=friendlyError(error);}
        this.event('background_check_recovery',friendlyError(error),job.id);await this.persist().catch(()=>{});
      }finally{this.localChecks.delete(job.uid);this.localActivity={kind:'idle'};this.onChange();}
    })();
    this.localChecks.set(job.uid,task);
  }
  async start({onlyUids=null,automatic=false}={}){
    if(this.starting)return;
    if(!this.running){this.allowedUids=new Set(onlyUids||[]);this.runAll=!onlyUids&&!automatic;}else if(onlyUids)for(const id of onlyUids)this.allowedUids.add(id);else if(!automatic)this.runAll=true;
    recoverDownloads(this.context().project);
    if(this.running){if(!automatic)await this.setPaused(false);return;}
    if(this.refreshing||this.assembling)throw Error('正在刷新或拼接，请等待当前操作完成。');
    this.starting=true;
    try{
      if(!this.transport.key&&!this.context().project.jobs.some(j=>['download','checking'].includes(j.state)&&j.attempts.at(-1)?.url))throw Error('请先解锁密钥。');
      if(!await permitted(this.context().folder))throw Error('请先选择或重新授权本地文件夹。');
      if(!automatic)await this.setPaused(false);else this.pauseNew=!!this.context().project.queueControl?.paused;
    }catch(error){this.starting=false;throw error;}
    this.running=true;this.starting=false;this.onChange();
    try{await navigator.locks.request('x-ai-production-runner',{ifAvailable:true},async lock=>{if(!lock)throw Error('另一个窗口正在运行，请到原窗口查看。');
      while(true){const p=this.context().project;
        for(const local of p.jobs.filter(j=>(j.state==='checking'&&downloadSaved(j)||j.state==='download'&&(downloadSaved(j)||j.attempts.at(-1)?.remoteReleasedAt))&&!this.localChecks.has(j.uid)))this.launchLocalCheck(local);
        if(p.jobs.some(unresolvedSubmission))throw Error('有提交结果待核实的任务。原请求已保留，不能重复生成。');
        let job=p.jobs.find(j=>(['queued','generating','download','checking','blocked','deferred','submitting','unknown'].includes(j.state)||j.state==='pending'&&j.attempts.at(-1)?.videoId)&&remoteBlocks(j)&&!this.localChecks.has(j.uid));
        if(job&&['pending','submitting','unknown'].includes(job.state)&&job.attempts.at(-1)?.videoId){job.state='queued';await this.persist(true);}
        if(!job&&!this.pauseNew&&this.transport.key)job=p.jobs.find(j=>j.state==='pending'&&(this.runAll||j.autoSubmit||this.allowedUids.has(j.uid))&&(!j.continuityFrom||p.jobs.some(prev=>prev.id===j.continuityFrom&&['ready','approved'].includes(prev.state)&&prev.current?.lastFrameKey)));
        if(!job){if(this.localChecks.size){await Promise.race(this.localChecks.values());continue;}const localRetry=p.jobs.find(j=>j.state==='checking'&&j.attempts.at(-1)?.localCheckRetryAt>Date.now());if(localRetry){this.setActivity({kind:'waiting',label:'本地校验引擎自动恢复，原片已保留',waitUntil:localRetry.attempts.at(-1).localCheckRetryAt});await sleep(1000);continue;}break;}
        if(!this.transport.key&&['pending','deferred','queued','generating'].includes(job.state))break;
        if(this.pauseNew&&job.state==='deferred')break;
        if(job.state==='blocked')throw Error(job.error||'当前任务恢复条件尚未满足。');
        this.activeUid=job.uid;await this.step(job);this.activeUid=null;this.setActivity({kind:'idle'});await sleep(200);
      }
    });}catch(e){this.message(friendlyError(e),true);this.event('queue_attention',friendlyError(e));await this.persist().catch(()=>{});}finally{this.running=false;this.activeUid=null;this.setActivity({kind:'idle'});this.onChange();}
  }
  async payload(job){
    const {project}=this.context();const check=validateJob(job,project.assets,project.jobs);if(check.errors.length)throw Error(check.errors.join('；'));
    const profile=modelProfile(job.profileId);if(profile.adapter!=='agnes')throw Error('当前平台的API适配器尚未实现。');
    const assets=job.assetIds.map(id=>project.assets.find(a=>a.id===id));const p={model:profile.model,seconds:String(job.seconds),mode:job.mode,size:profile.resolution,aspect_ratio:job.aspect,n:1};if(job.seed!==null&&job.seed!==undefined&&job.seed!=='')p.seed=Number(job.seed);
    const encode=async a=>{const b=await readAsset(a);if(await sha256(b)!==a.sha256)throw Error(`${a.name}哈希改变，请重新导入。`);return dataURL(b);};
    if(job.mode==='reference'){
      p.images=await Promise.all(assets.filter(a=>a.kind==='image').map(encode));p.audios=await Promise.all(assets.filter(a=>a.kind==='audio').map(encode));
      if(job.continuityFrom){const prev=project.jobs.find(j=>j.id===job.continuityFrom);if(!prev?.current?.lastFrameKey||!['ready','approved'].includes(prev.state))throw Error('上一镜当前版本尚未通过技术检查，请先处理上一镜。');p.images.push(await dataURL(await blob(prev.current.lastFrameKey)));}
    }
    if(job.mode==='keyframe'){for(const [key,id] of [['first_frame',job.firstFrame],['last_frame',job.lastFrame]])if(id)p[key]=await encode(project.assets.find(a=>a.id===id));}
    p.prompt=requestPrompt(job,p.images?.length||0);if(new TextEncoder().encode(JSON.stringify(p)).length>=50_000_000)throw Error('请求体超过50MB，请减少素材体积。');return p;
  }
  async step(job){
    let attempt=job.attempts.at(-1);
    // Recovery trusts the original identifier over an accidentally stale UI state.
    if(['pending','deferred'].includes(job.state)&&attempt&&!attempt.resolved){
      if(attempt.videoId){job.state='queued';await this.persist(true);return;}
      if(job.state==='pending'&&attempt.submittedAt&&!attempt.rejectedBeforeCreation){job.state='unknown';job.error='已有未解决的提交记录，请核实原任务后继续。';await this.persist(true);return;}
    }
    if(job.state==='pending'||job.state==='deferred'){
      if(this.pauseNew)return;await this.beforeNew();let payload;
      this.setActivity({kind:'prepare',label:'正在读取并校验本镜素材'});try{payload=await this.payload(job);}catch(e){job.state='invalid';job.error=friendlyError(e);this.event('validation_failed',job.error,job.id);await this.persist();return;}
      if(!attempt||attempt.resolved){attempt={number:job.attempts.length+1,createdAt:now(),reason:job.revisionReason||'首次生成',snapshot:JSON.parse(JSON.stringify({prompt:job.prompt,dialogue:job.dialogue,mode:job.mode,seconds:job.seconds,aspect:job.aspect,assetIds:job.assetIds,firstFrame:job.firstFrame,lastFrame:job.lastFrame,continuityFrom:job.continuityFrom,textSources:job.textSources||[],referenceReplacements:job.referenceReplacements||[]})),request:redact(payload),requestHash:await sha256(JSON.stringify(payload)),inputHashes:[...new Set([...job.assetIds,job.firstFrame,job.lastFrame].filter(Boolean))].map(id=>({id,sha256:this.context().project.assets.find(a=>a.id===id)?.sha256}))};if(job.continuityFrom){const prev=this.context().project.jobs.find(j=>j.id===job.continuityFrom);attempt.continuityInput={shot:prev.id,path:prev.current.lastFramePath,sha256:prev.current.lastFrameSha256,clipSha256:prev.current.sha256};}job.attempts.push(attempt);}
      job.error=null;attempt.preparedAt=now();this.event('submit_prepared','已写入待提交检查点，等待请求间隔',job.id);await this.persist(true);
      try{const response=await this.transport.api('/v1/videos',payload,async()=>{if(this.pauseNew){const e=Error('已暂停新提交');e.name='QueuePaused';throw e;}job.state='submitting';delete attempt.rejectedBeforeCreation;attempt.submittedAt=now();this.event('submitting','即将发送请求，已保存提交检查点',job.id);await this.persist(true);attempt.sentAt=now();this.onChange();});attempt.response=redact(response);attempt.videoId=nested(response,['video_id']);if(typeof attempt.videoId!=='string'||!attempt.videoId){delete attempt.videoId;job.state='unknown';job.error='接口没有返回video_id。请核实服务端任务，不要重新提交。';this.event('submission_unknown',job.error,job.id);await this.persist(true);return;}
        attempt.submittedAt=attempt.submittedAt||now();attempt.sentAt=attempt.sentAt||attempt.submittedAt;attempt.acceptedAt=now();const cooldown=submissionCooldown(this.context().project,job.profileId);if(cooldown.seconds){try{const stored=await get('state','submission-cooldowns')||{};stored[cooldown.key]=Math.max(Number(stored[cooldown.key])||0,Date.parse(attempt.acceptedAt));await put('state','submission-cooldowns',stored);}catch{this.message('提交已成功；浏览器冷却记录暂未保存，当前任务记录仍保留冷却时间。',true);}this.message(cooldownMessage(cooldown));}
        attempt.taskId=nested(response,['task_id','id']);attempt.firstPollAt=Date.now()+firstPollDelay(this.context().project,job.profileId);job.state='queued';this.event('accepted','video_id='+attempt.videoId,job.id);await this.persist(true);return;
      }catch(e){if(e.name==='QueuePaused'||e.name==='MissingCredential'){job.state='pending';job.error=e.name==='MissingCredential'?e.message:null;await this.persist();return;}attempt.lastProblem=networkRecord(e);attempt.submitError=redact(e.body||friendlyError(e));
        if(e instanceof APIError){const type=classifyHTTP(e.status,e.body,true);if(type==='deferred'){attempt.rejectedBeforeCreation=true;job.state='deferred';job.error='服务端明确拒绝本次创建，按限流反馈逐步调整间隔后重试。';attempt.deferrals=(attempt.deferrals||0)+1;}else if(type==='rejected'){job.state='failed';attempt.resolved=true;attempt.rejectedBeforeCreation=true;job.error=friendlyError(e);if([401,403].includes(e.status)){this.pauseNew=true;this.context().project.queueControl={paused:true,updatedAt:now()};}}else{job.state='unknown';job.error='提交结果不明。请保留请求记录并核实video_id，禁止直接重发。';}}
        else{job.state='unknown';job.error=friendlyError(e)+' 提交可能已被接受，请先核实。';}this.event(job.state,job.error,job.id);await this.persist(true);return;
      }
    }
    if(['queued','generating'].includes(job.state)){
      if(!attempt?.videoId){job.state='unknown';job.error='缺少video_id，请核实创建结果。';await this.persist();return;}
      let response;try{response=await this.transport.api('/agnesapi?'+new URLSearchParams({video_id:attempt.videoId,model_name:attempt.request?.model||modelProfile(job.profileId).model}),undefined,undefined,{notBefore:attempt.polledAt?Date.parse(attempt.polledAt)+10000:attempt.firstPollAt||0});}catch(e){attempt.lastProblem=networkRecord(e);job.error=friendlyError(e);attempt.pollErrors=(attempt.pollErrors||0)+1;this.event('poll_error',job.error,job.id);if(e instanceof APIError&&[400,401,403,404].includes(e.status)&&!platformPenalty(e.status,e.body,e.retryAfter)){
          if([401,403].includes(e.status)&&e.credentialChanged&&this.transport.key){job.error=null;}
          else{job.state='blocked';attempt.pollCredentialRejected=[401,403].includes(e.status);}
        }await this.persist();return;}
      attempt.pollResponse=redact(response);attempt.polledAt=now();attempt.pollErrors=0;const status=String(nested(response,['status'])||'unknown').toLowerCase();const progress=reportedProgress(nested(response,['progress']));job.progressKnown=progress!==null;job.progress=progress??0;job.error=null;
      if(['failed','error','cancelled','canceled'].includes(status)){job.state='failed';attempt.resolved=true;attempt.terminalConfirmed=true;job.error=String(nested(response,['message'])||nested(response,['code'])||'服务端已确认生成失败，打开详情查看原因。');this.event('remote_failed',job.error,job.id);}
      else if(['completed','success','succeeded'].includes(status)){attempt.remoteCompletedAt=attempt.remoteCompletedAt||now();attempt.url=nested(response,['url','video_url']);job.state=attempt.url?'download':'queued';if(!attempt.url){job.error=null;this.event('result_wait','服务端已完成，自动等待下载链接返回',job.id);}}
      else if(['queued','pending'].includes(status)){job.state='queued';attempt.queuePolls=(attempt.queuePolls||0)+1;}
      else job.state='generating';await this.persist(true);return;
    }
    if(['download','checking'].includes(job.state)){
      const {folder}=this.context();let reading=true;
      let file=await savedDownload(folder,job);
      // A verified local original takes priority over a stale network backoff.
      if(!file&&attempt.downloadRetryAt){this.setActivity({kind:'recovery',label:attempt.downloadWaitingFor==='browser-permission'?'等待浏览器允许本机访问':attempt.downloadWaitingFor==='local-service'?'本机下载服务未连接 · 自动检测中':attempt.downloadWaitingFor?'等待下载通道恢复 · 自动检测中':`下载恢复 · 已尝试 ${attempt.downloadFailures||0} 轮`,waitUntil:attempt.downloadRetryAt});let checkedAt=Date.now();while(Date.now()<attempt.downloadRetryAt){await sleep(Math.min(1000,attempt.downloadRetryAt-Date.now()));if(Date.now()-checkedAt>=30000){file=await savedDownload(folder,job);checkedAt=Date.now();if(file)break;}}}
      // Offline recovery wakes immediately on 'online', rather than losing the job.
      while(!file&&navigator.onLine===false){this.setActivity({kind:'recovery',label:'网络恢复后自动继续下载'});await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);window.removeEventListener('online',finish);resolve();};const timer=setTimeout(finish,30000);window.addEventListener('online',finish,{once:true});});file=await savedDownload(folder,job);}
      try{
        if(!file){file=await this.transport.media(attempt.url);if(file.downloadDiagnostic)attempt.downloadDiagnostic=file.downloadDiagnostic;}
        reading=false;delete attempt.downloadRetryAt;delete attempt.downloadWaitingFor;attempt.downloadRecovery=false;await this.saveDownloaded(job,file,attempt);delete attempt.forceDownload;this.launchLocalCheck(job,file);
      }catch(e){
        attempt.lastProblem=networkRecord(e)||{at:now(),operation:reading?'media':'local',connection:this.context().project.settings.connection,code:e.name||'error',message:friendlyError(e)};
        if(e.diagnostic)attempt.downloadDiagnostic=e.diagnostic;
        if(e instanceof ConnectionError&&e.operation==='media'&&!e.permanent){
          attempt.downloadFailures=(attempt.downloadFailures||0)+1;attempt.downloadRecovery=true;job.state='download';job.error=null;
          attempt.downloadWaitingFor=e.waitingFor||null;
          (attempt.downloadErrors??=[]).push(attempt.lastProblem);attempt.downloadErrors=attempt.downloadErrors.slice(-20);
          attempt.downloadPacingVersion=2;attempt.downloadRetryAt=Math.max(Date.now()+downloadDelay(),e.retryAt||0);this.event('download_recovery','自动恢复原任务下载，第 '+attempt.downloadFailures+' 轮',job.id);await this.persist();
          if(this.transport.key&&shouldRefreshLink(attempt,e)){
            attempt.downloadLinkCheckedAt=Date.now();
            try{const response=await this.transport.api('/agnesapi?'+new URLSearchParams({video_id:attempt.videoId,model_name:attempt.request?.model||modelProfile(job.profileId).model}));const url=nested(response,['url','video_url']);if(typeof url==='string'&&url&&url!==attempt.url){(attempt.downloadUrlHistory??=[]).push({url:attempt.url,at:now()});attempt.downloadUrlHistory=attempt.downloadUrlHistory.slice(-5);attempt.url=url;attempt.downloadRetryAt=Date.now();this.event('download_link_refreshed','已查询原任务并更新下载地址',job.id);}attempt.pollResponse=redact(response);attempt.polledAt=now();}catch(error){attempt.downloadQueryError=networkRecord(error)||{at:now(),message:friendlyError(error)};}
            await this.persist();
          }
          return;
        }
        attempt.downloadPermanent=reading&&!!e.permanent;job.state='blocked';job.error=reading?'原视频下载响应未通过安全检查，原任务已保留。':friendlyError(e);this.event('local_processing_failed',job.error,job.id);await this.persist();
      }
    }
  }
  async saveDownloaded(job,file,attempt=job.attempts.at(-1)){
    const {folder}=this.context();this.setActivity({kind:'save',label:'核对视频哈希并保存原始文件'});const incomingHash=await sha256(file);
    const priorRawHash=attempt.rawSha256||attempt.sha256;
    if(priorRawHash&&priorRawHash!==incomingHash&&!attempt.replacingDownload){const old={...attempt};delete old.downloadHistory;(attempt.downloadHistory??=[]).push(old);attempt.downloadSequence=(attempt.downloadSequence||1)+1;attempt.replacingDownload=true;}
    const suffix=attempt.downloadSequence?'_d'+attempt.downloadSequence:'';
    attempt.rawSha256=incomingHash;attempt.rawBytes=file.size;attempt.rawBlobKey='raw:'+job.uid+':'+attempt.number+suffix;await storeBlob(attempt.rawBlobKey,file);attempt.rawPath=rawDownloadPath(job,attempt);await writeFile(folder,attempt.rawPath,file);
    attempt.downloadCompleteAt=now();await writeDownloadReceipt(folder,job,attempt);if(attempt.videoId)attempt.remoteReleasedAt=attempt.remoteReleasedAt||attempt.downloadCompleteAt;job.state='checking';job.error=null;this.event('downloaded','原片已保存，后台校验；后续独立镜头可继续提交',job.id);await this.persist(true);
  }
  async acceptFile(job,file,attempt=job.attempts.at(-1),{autoDownload=false,background=false}={}){
    if(!attempt)throw Error('没有可对应的生成尝试，请先建立任务记录。');const {folder}=this.context();
    const activity=value=>background?this.setLocalActivity(job,value):this.setActivity(value);
    const incomingHash=await sha256(file);if(!downloadSaved(job)||attempt.rawSha256!==incomingHash)await this.saveDownloaded(job,file,attempt);
    const suffix=attempt.downloadSequence?'_d'+attempt.downloadSequence:'';
    activity({kind:'check',label:'正在检查视频容器与时长'});let qa;
    try{qa=await inspectVideo(file,job,{deep:true,onProgress:value=>activity({kind:'check',...value})});if(autoDownload&&(qa.fullDecode==='failed'||qa.fatal.some(s=>/MP4容器|过小/.test(s))))throw new ConnectionError('media','local',{name:'CorruptDownload'});if(autoDownload&&qa.technical==='partial'){const failure=new Error('本地解码引擎暂不可用，原片已保留，30秒后自动恢复校验。');failure.name='LocalCheckUnavailable';throw failure;}}
    catch(error){if(autoDownload&&error.name!=='LocalCheckUnavailable'&&(error instanceof ConnectionError||error.name==='CorruptDownload'||/视频.*(加载|解码|元数据)/.test(error.message))){attempt.discardedDownload={at:now(),path:attempt.rawPath,sha256:incomingHash,bytes:file.size};delete attempt.rawBlobKey;delete attempt.rawPath;delete attempt.rawSha256;delete attempt.downloadCompleteAt;throw error instanceof ConnectionError?error:new ConnectionError('media','local',{name:'CorruptDownload'});}throw error;}
    const samples=qa.samples,playbackFile=qa.playbackFile||file;delete qa.samples;delete qa.playbackFile;attempt.qa=qa;attempt.sha256=await sha256(playbackFile);attempt.bytes=playbackFile.size;if(qa.normalization)attempt.playbackSource={path:attempt.rawPath,sha256:incomingHash,bytes:file.size,transform:qa.normalization};else delete attempt.playbackSource;attempt.path=`clips/${job.episode}/${job.id}_v${attempt.number}${suffix}.mp4`;attempt.blobKey='clip:'+job.uid+':'+attempt.number+suffix;activity({kind:'save',label:'正在保存视频、抽帧与核验记录'});await storeBlob(attempt.blobKey,playbackFile);await writeFile(folder,attempt.path,playbackFile);
    if(samples){attempt.frameDirectory=`checks/${job.id}_v${attempt.number}${suffix}`;attempt.frameKeys=[];for(let i=0;i<samples.frames.length;i++){const key=`frame:${job.uid}:${attempt.number}${suffix}:${i}`;await storeBlob(key,samples.frames[i]);attempt.frameKeys.push(key);await writeFile(folder,`${attempt.frameDirectory}/frame_${i+1}.jpg`,samples.frames[i]);}attempt.lastFrameKey=`last:${job.uid}:${attempt.number}${suffix}`;await storeBlob(attempt.lastFrameKey,samples.last);attempt.lastFramePath=`${attempt.frameDirectory}/last.png`;attempt.lastFrameSha256=await sha256(samples.last);await writeFile(folder,attempt.lastFramePath,samples.last);}
    delete attempt.lastProblem;delete attempt.localCheckRetryAt;delete attempt.replacingDownload;attempt.resolved=true;attempt.downloadedAt=now();job.current=JSON.parse(JSON.stringify(attempt));job.state=qa.fatal.length?'needs_redo':qa.technical==='passed'?'ready':'blocked';job.review='pending';job.error=qa.fatal.join('；')|| (qa.technical==='partial'?'尚未完成深度校验，请重试校验。':null);
    await writeFile(folder,`checks/${job.id}_v${attempt.number}${suffix}/report.json`,JSON.stringify(qa,null,2));this.event('checked',`${job.state}；${qa.fatal.join('；')} ${qa.warnings.join('；')}`,job.id);await this.persist(true);
  }
  async retryDownload(job){const a=job.attempts.at(-1);if(!a?.url)throw Error('没有下载地址，请先查询原任务。');if(a.videoId&&a.resolved)a.remoteReleasedAt=a.remoteReleasedAt||a.downloadedAt||now();a.forceDownload=true;job.state='download';job.error=null;await this.persist();return this.start();}
  async resumeKnown(job){const a=job.attempts.at(-1);if(!a?.videoId)throw Error('请先绑定原video_id。');if(a.terminalConfirmed)throw Error('服务端已确认终止，请在详情中修订为新版本。');job.state='queued';job.error=null;await this.persist();return this.start();}
  async redo(job,prompt,dialogue,reason,changes={}){const prior=job.attempts.at(-1);if(prior?.videoId&&!prior.resolved&&!prior.terminalConfirmed)throw Error('原任务尚未确认结束，请继续查询原编号。');if(['unknown','submitting','queued','generating','deferred','download','checking'].includes(job.state))throw Error('当前任务尚未结束，不能创建新尝试。');if(job.state==='blocked'&&!job.current)throw Error('请先恢复原任务或校验，不要重复生成。');const candidate=promptSpec({...job,...changes,prompt,dialogue});const check=validateJob(candidate,this.context().project.assets,this.context().project.jobs);if(check.errors.length)throw Error(check.errors.join('；'));Object.assign(job,candidate);job.revisionReason=reason;job.review='pending';job.error=null;if(job.attempts.at(-1))job.attempts.at(-1).resolved=true;job.current=null;job.state='pending';this.event('revision',reason,job.id);await this.persist(true);}
  async assemble(episode,onProgress=()=>{}){if(this.running||this.refreshing||this.assembling)throw Error('当前仍在处理任务，请稍后再拼接。');this.assembling=true;this.setActivity({kind:'assemble',label:'正在核对本集输入与加载媒体引擎'});try{return await this.assembleFiles(episode,progress=>{this.setActivity({kind:'assemble',label:'正在本地拼接 '+episode,percent:Math.min(99,Math.max(0,progress*100))});onProgress(progress);});}finally{this.assembling=false;this.setActivity({kind:'idle'});this.onChange();}}
  async assembleFiles(episode,onProgress){const {project,folder}=this.context();const jobs=project.jobs.filter(j=>j.episode===episode);if(!jobs.length||jobs.some(j=>!['ready','approved'].includes(j.state)||j.current?.qa?.technical!=='passed'))throw Error('本集仍有未通过技术校验的镜头。');if(new Set(jobs.map(j=>j.aspect)).size!==1)throw Error('本集画幅不同，请先统一画幅或分组。');if(jobs.some(j=>!j.current.qa.hasAudio))throw Error('本集中存在无音轨镜头，请先在本地编辑器补音轨。');
    const fingerprints=jobs.map(j=>({id:j.id,path:j.current.path,sha256:j.current.sha256}));const files=[];for(const j of jobs){const b=await blob(j.current.blobKey);if(await sha256(b)!==j.current.sha256)throw Error(j.id+'文件哈希不一致。');files.push(b);}
    const actualInputs=await Promise.all(files.map(videoMetadata));const planned=actualInputs.reduce((s,info)=>s+info.duration,0);
    const file=await concatenate(files,DIMENSIONS[jobs[0].aspect],onProgress),info=await videoMetadata(file);if(Math.abs(info.duration-planned)>.5)throw Error('合并后时长与输入原片总时长不符，保留原镜头，请重试拼接。');const decode=await deepCheck(file,value=>this.setActivity({kind:'assemble',...value}));if(decode.fullDecode!=='passed')throw Error('整集完整解码未通过。');
    this.setActivity({kind:'assemble',label:'正在保存分集视频与输入清单'});const version=project.episodes.filter(e=>e.id===episode).length+1,path=`episodes/${episode}_v${version}.mp4`,hash=await sha256(file),key='episode:'+uid();await storeBlob(key,file);await writeFile(folder,path,file);
    const record={id:episode,version,path,sha256:hash,blobKey:key,seconds:info.duration,inputs:fingerprints,createdAt:now(),fullDecode:'passed',review:jobs.every(j=>j.review==='approved')?'人工已审各镜，整集仍待审核':'整集内容待审核'};project.episodes.push(record);await writeFile(folder,`episodes/${episode}_v${version}_inputs.json`,JSON.stringify(record,null,2));this.event('episode_ready',`${episode} ${info.duration.toFixed(2)}秒，版本${version}`);await this.persist(true);return record;
  }
}
