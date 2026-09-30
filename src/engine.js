import {MODEL,ORIGINS,DIMENSIONS,now,uid,sha256,redact,nested,classifyHTTP,friendlyError,validateJob,requestPrompt,recordEvent} from './core.js';
import {get,put,blob,storeBlob,saveProject,writeFile,permitted,reportMarkdown,readAsset} from './storage.js';
import {dataURL,inspectVideo,concatenate,videoMetadata,deepCheck} from './media.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class APIError extends Error{constructor(status,body){super(`接口返回${status}：${String(nested(body,['message','detail'])||'请求未成功').slice(0,140)}`);this.status=status;this.body=body;}}
export class Transport {
  constructor(context){this.context=context;this.key='';this.bridgeToken='';this.nextAt=0;}
  async api(route,payload){
    if(!this.key)throw Error('请先解锁 API 密钥。');const {project}=this.context();const settings=project.settings;
    if(!ORIGINS.includes(settings.origin)||!route.startsWith('/')||route.startsWith('//'))throw Error('接口地址不受信任。');
    return navigator.locks.request('x-ai-auth-http',async()=>{
      const rate=await get('state','rate')||{last:0,notBefore:0};const gap=Math.max(90,Number(settings.gap)||90)*1000;
      this.nextAt=Math.max(rate.last+gap,rate.notBefore||0);while(Date.now()<this.nextAt)await sleep(Math.min(1000,this.nextAt-Date.now()));
      // Persist the slot BEFORE sending any authenticated request. Failed calls count too.
      await put('state','rate',{...rate,last:Date.now()});this.nextAt=Date.now()+gap;
      const bridge=settings.connection==='bridge';if(bridge&&!this.bridgeToken)throw Error('请填写本机连接器配对码。');
      const url=bridge?'http://127.0.0.1:4174/api'+route:settings.origin+route;
      const headers={'Authorization':'Bearer '+this.key,'Accept':'application/json'};
      if(payload)headers['Content-Type']='application/json';if(bridge){headers['X-XAI-Token']=this.bridgeToken;headers['X-XAI-Origin']=settings.origin;}
      const response=await fetch(url,{method:payload?'POST':'GET',headers,body:payload?JSON.stringify(payload):undefined,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(180000)});
      const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{throw Error('接口未返回JSON，保留当前任务，请检查连接。');}
      if(!response.ok)throw new APIError(response.status,redact(body));return body;
    });
  }
  async backoff(level=1){const rate=await get('state','rate')||{};rate.notBefore=Math.max(rate.notBefore||0,Date.now()+Math.min(3600,90*2**Math.min(level,6))*1000);await put('state','rate',rate);this.nextAt=rate.notBefore;}
  async media(url){
    let parsed;try{parsed=new URL(url);}catch{throw Error('结果下载地址无效。');}if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('只允许无内嵌凭据的HTTPS媒体链接。');
    const {project}=this.context(),bridge=project.settings.connection==='bridge';
    const res=await fetch(bridge?'http://127.0.0.1:4174/media':url,{method:bridge?'POST':'GET',headers:bridge?{'Content-Type':'application/json','X-XAI-Token':this.bridgeToken}:{},body:bridge?JSON.stringify({url}):undefined,credentials:'omit',signal:AbortSignal.timeout(180000)});
    if(!res.ok)throw Error(`视频下载失败（${res.status}），可重试下载或手动导入，不必重新生成。`);
    if(Number(res.headers.get('content-length')||0)>512_000_000)throw Error('文件超过512MB，请手动下载检查。');
    const reader=res.body.getReader(),parts=[];let length=0;while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>512_000_000){await reader.cancel();throw Error('下载超过512MB安全上限。');}parts.push(value);}return new Blob(parts,{type:'video/mp4'});
  }
}
export class Runner {
  constructor(context,onChange,onMessage){this.context=context;this.onChange=onChange;this.message=onMessage;this.transport=new Transport(context);this.running=false;this.pauseNew=false;}
  async persist(disk=false){const {project,folder}=this.context();await saveProject(project,folder,{requireDisk:disk});if(folder&&await permitted(folder))await writeFile(folder,'X-AI_制作过程与结果.md',reportMarkdown(project));this.onChange();}
  event(kind,msg,id){recordEvent(this.context().project,kind,msg,id);}
  async start(){
    if(this.running){this.pauseNew=false;this.message('队列已恢复，继续当前任务。');return;}
    if(!this.transport.key)throw Error('请先解锁密钥。');if(!await permitted(this.context().folder))throw Error('请先选择或重新授权本地文件夹。');
    this.pauseNew=false;this.running=true;this.onChange();
    try{await navigator.locks.request('x-ai-production-runner',{ifAvailable:true},async lock=>{if(!lock)throw Error('另一个窗口正在运行，请到原窗口查看。');
      while(true){const p=this.context().project;
        if(p.jobs.some(j=>['submitting','unknown'].includes(j.state)))throw Error('有提交结果待核实的任务。请先绑定原video_id，或核实未创建任务，再继续。');
        let job=p.jobs.find(j=>['queued','generating','download','checking','blocked','deferred'].includes(j.state));
        if(!job&&!this.pauseNew)job=p.jobs.find(j=>j.state==='pending');if(!job||this.pauseNew&&job.state==='deferred')break;
        if(job.state==='blocked')throw Error(job.error||'当前任务需要处理，请打开详情。');
        await this.step(job);await sleep(200);
      }
    });}catch(e){this.message(friendlyError(e),true);this.event('queue_attention',friendlyError(e));await this.persist().catch(()=>{});}finally{this.running=false;this.onChange();}
  }
  async payload(job){
    const {project}=this.context();const check=validateJob(job,project.assets,project.jobs);if(check.errors.length)throw Error(check.errors.join('；'));
    const assets=job.assetIds.map(id=>project.assets.find(a=>a.id===id));const p={model:MODEL,seconds:String(job.seconds),mode:job.mode,size:'720P',aspect_ratio:job.aspect,n:1};if(job.seed!==null&&job.seed!==undefined&&job.seed!=='')p.seed=Number(job.seed);
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
      if(job.state==='pending'&&attempt.submittedAt){job.state='unknown';job.error='已有未解决的提交记录，请核实原任务后继续。';await this.persist(true);return;}
    }
    if(job.state==='pending'||job.state==='deferred'){
      if(this.pauseNew)return;let payload;
      try{payload=await this.payload(job);}catch(e){job.state='invalid';job.error=friendlyError(e);this.event('validation_failed',job.error,job.id);await this.persist();return;}
      if(!attempt||attempt.resolved){attempt={number:job.attempts.length+1,createdAt:now(),reason:job.revisionReason||'首次生成',snapshot:JSON.parse(JSON.stringify({prompt:job.prompt,dialogue:job.dialogue,mode:job.mode,seconds:job.seconds,aspect:job.aspect,assetIds:job.assetIds,firstFrame:job.firstFrame,lastFrame:job.lastFrame,continuityFrom:job.continuityFrom,textSources:job.textSources||[],referenceReplacements:job.referenceReplacements||[]})),request:redact(payload),requestHash:await sha256(JSON.stringify(payload)),inputHashes:[...new Set([...job.assetIds,job.firstFrame,job.lastFrame].filter(Boolean))].map(id=>({id,sha256:this.context().project.assets.find(a=>a.id===id)?.sha256}))};if(job.continuityFrom){const prev=this.context().project.jobs.find(j=>j.id===job.continuityFrom);attempt.continuityInput={shot:prev.id,path:prev.current.lastFramePath,sha256:prev.current.lastFrameSha256,clipSha256:prev.current.sha256};}job.attempts.push(attempt);}
      job.state='submitting';job.error=null;attempt.submittedAt=now();this.event('submitting','已写入提交前检查点',job.id);await this.persist(true);
      try{const response=await this.transport.api('/v1/videos',payload);attempt.response=redact(response);attempt.videoId=nested(response,['video_id']);if(typeof attempt.videoId!=='string'||!attempt.videoId){delete attempt.videoId;job.state='unknown';job.error='接口没有返回video_id。请核实服务端任务，不要重新提交。';this.event('submission_unknown',job.error,job.id);await this.persist(true);return;}
        attempt.taskId=nested(response,['task_id','id']);job.state='queued';this.event('accepted','video_id='+attempt.videoId,job.id);await this.persist(true);return;
      }catch(e){attempt.submitError=redact(e.body||friendlyError(e));
        if(e instanceof APIError){const type=classifyHTTP(e.status,e.body,true);if(type==='deferred'){job.state='deferred';job.error='服务端明确拒绝本次创建，等待更长间隔后再提交。';attempt.deferrals=(attempt.deferrals||0)+1;await this.transport.backoff(attempt.deferrals);}else if(type==='rejected'){job.state='failed';attempt.resolved=true;attempt.rejectedBeforeCreation=true;job.error=friendlyError(e);if([401,403].includes(e.status))this.pauseNew=true;}else{job.state='unknown';job.error='提交结果不明。请保留请求记录并核实video_id，禁止直接重发。';}}
        else{job.state='unknown';job.error=friendlyError(e)+' 提交可能已被接受，请先核实。';}this.event(job.state,job.error,job.id);await this.persist(true);return;
      }
    }
    if(['queued','generating'].includes(job.state)){
      if(!attempt?.videoId){job.state='unknown';job.error='缺少video_id，请核实创建结果。';await this.persist();return;}
      let response;try{response=await this.transport.api('/agnesapi?'+new URLSearchParams({video_id:attempt.videoId,model_name:MODEL}));}catch(e){job.error=friendlyError(e);attempt.pollErrors=(attempt.pollErrors||0)+1;this.event('poll_error',job.error,job.id);if(e instanceof APIError&&[400,401,403,404].includes(e.status))job.state='blocked';else await this.transport.backoff(attempt.pollErrors);await this.persist();return;}
      attempt.pollResponse=redact(response);attempt.polledAt=now();attempt.pollErrors=0;const status=String(nested(response,['status'])||'unknown').toLowerCase();job.progress=Number(nested(response,['progress'])||0);job.error=null;
      if(['failed','error','cancelled','canceled'].includes(status)){job.state='failed';attempt.resolved=true;attempt.terminalConfirmed=true;job.error=String(nested(response,['message'])||nested(response,['code'])||'服务端已确认生成失败，打开详情查看原因。');this.event('remote_failed',job.error,job.id);}
      else if(['completed','success','succeeded'].includes(status)){attempt.url=nested(response,['url','video_url']);job.state=attempt.url?'download':'blocked';if(!attempt.url)job.error='任务完成但没有下载链接。请查询原任务，勿重新生成。';}
      else if(['queued','pending'].includes(status)){job.state='queued';attempt.queuePolls=(attempt.queuePolls||0)+1;await this.transport.backoff(Math.min(5,Math.floor(attempt.queuePolls/3)));}
      else job.state='generating';await this.persist(true);return;
    }
    if(['download','checking'].includes(job.state)){
      try{const file=attempt.rawBlobKey&&!attempt.forceDownload?await blob(attempt.rawBlobKey):await this.transport.media(attempt.url);await this.acceptFile(job,file,attempt);delete attempt.forceDownload;}catch(e){job.state='blocked';job.error=friendlyError(e);this.event('local_processing_failed',job.error,job.id);await this.persist();}
    }
  }
  async acceptFile(job,file,attempt=job.attempts.at(-1)){
    if(!attempt)throw Error('没有可对应的生成尝试，请先建立任务记录。');const {folder}=this.context();
    const incomingHash=await sha256(file);
    if(attempt.sha256&&attempt.sha256!==incomingHash){const old={...attempt};delete old.downloadHistory;(attempt.downloadHistory??=[]).push(old);attempt.downloadSequence=(attempt.downloadSequence||1)+1;}
    const suffix=attempt.downloadSequence?'_d'+attempt.downloadSequence:'';
    attempt.rawSha256=incomingHash;attempt.rawBlobKey='raw:'+job.uid+':'+attempt.number+suffix;await storeBlob(attempt.rawBlobKey,file);attempt.rawPath=`raw/${job.episode}/${job.id}_v${attempt.number}${suffix}.mp4`;await writeFile(folder,attempt.rawPath,file);
    job.state='checking';this.event('downloaded','已保存原始文件，开始本地完整解码',job.id);await this.persist(true);
    const qa=await inspectVideo(file,job,{deep:true});const samples=qa.samples;delete qa.samples;attempt.qa=qa;attempt.sha256=incomingHash;attempt.bytes=file.size;attempt.path=`clips/${job.episode}/${job.id}_v${attempt.number}${suffix}.mp4`;attempt.blobKey='clip:'+job.uid+':'+attempt.number+suffix;await storeBlob(attempt.blobKey,file);await writeFile(folder,attempt.path,file);
    if(samples){attempt.frameDirectory=`checks/${job.id}_v${attempt.number}${suffix}`;attempt.frameKeys=[];for(let i=0;i<samples.frames.length;i++){const key=`frame:${job.uid}:${attempt.number}${suffix}:${i}`;await storeBlob(key,samples.frames[i]);attempt.frameKeys.push(key);await writeFile(folder,`${attempt.frameDirectory}/frame_${i+1}.jpg`,samples.frames[i]);}attempt.lastFrameKey=`last:${job.uid}:${attempt.number}${suffix}`;await storeBlob(attempt.lastFrameKey,samples.last);attempt.lastFramePath=`${attempt.frameDirectory}/last.png`;attempt.lastFrameSha256=await sha256(samples.last);await writeFile(folder,attempt.lastFramePath,samples.last);}
    attempt.resolved=true;attempt.downloadedAt=now();job.current=JSON.parse(JSON.stringify(attempt));job.state=qa.fatal.length?'needs_redo':qa.technical==='passed'?'ready':'blocked';job.review='pending';job.error=qa.fatal.join('；')|| (qa.technical==='partial'?'尚未完成深度校验，请重试校验。':null);
    await writeFile(folder,`checks/${job.id}_v${attempt.number}${suffix}/report.json`,JSON.stringify(qa,null,2));this.event('checked',`${job.state}；${qa.fatal.join('；')} ${qa.warnings.join('；')}`,job.id);await this.persist(true);
  }
  async retryDownload(job){const a=job.attempts.at(-1);if(!a?.url)throw Error('没有下载地址，请先查询原任务。');a.forceDownload=true;job.state='download';job.error=null;await this.persist();return this.start();}
  async resumeKnown(job){const a=job.attempts.at(-1);if(!a?.videoId)throw Error('请先绑定原video_id。');if(a.terminalConfirmed)throw Error('服务端已确认终止，请在详情中修订为新版本。');job.state='queued';job.error=null;await this.persist();return this.start();}
  async redo(job,prompt,dialogue,reason,changes={}){const prior=job.attempts.at(-1);if(prior?.videoId&&!prior.resolved&&!prior.terminalConfirmed)throw Error('原任务尚未确认结束，请继续查询原编号。');if(['unknown','submitting','queued','generating','deferred','download','checking'].includes(job.state))throw Error('当前任务尚未结束，不能创建新尝试。');if(job.state==='blocked'&&!job.current)throw Error('请先恢复原任务或校验，不要重复生成。');const candidate={...job,...changes,prompt,dialogue};const check=validateJob(candidate,this.context().project.assets,this.context().project.jobs);if(check.errors.length)throw Error(check.errors.join('；'));Object.assign(job,changes);job.prompt=prompt;job.dialogue=dialogue;job.revisionReason=reason;job.review='pending';job.error=null;if(job.attempts.at(-1))job.attempts.at(-1).resolved=true;job.current=null;job.state='pending';this.event('revision',reason,job.id);await this.persist(true);}
  async assemble(episode,onProgress){const {project,folder}=this.context();const jobs=project.jobs.filter(j=>j.episode===episode);if(!jobs.length||jobs.some(j=>!['ready','approved'].includes(j.state)||j.current?.qa?.technical!=='passed'))throw Error('本集仍有未通过技术校验的镜头。');if(new Set(jobs.map(j=>j.aspect)).size!==1)throw Error('本集画幅不同，请先统一画幅或分组。');if(jobs.some(j=>!j.current.qa.hasAudio))throw Error('本集中存在无音轨镜头，请先在本地编辑器补音轨。');
    const fingerprints=jobs.map(j=>({id:j.id,path:j.current.path,sha256:j.current.sha256}));const files=[];for(const j of jobs){const b=await blob(j.current.blobKey);if(await sha256(b)!==j.current.sha256)throw Error(j.id+'文件哈希不一致。');files.push(b);}
    const file=await concatenate(files,DIMENSIONS[jobs[0].aspect],onProgress),info=await videoMetadata(file);const planned=jobs.reduce((s,j)=>s+j.seconds,0);if(Math.abs(info.duration-planned)>.5)throw Error('合并后时长不符，保留原镜头，请检查单镜时长。');const decode=await deepCheck(file);if(decode.fullDecode!=='passed')throw Error('整集完整解码未通过。');
    const version=project.episodes.filter(e=>e.id===episode).length+1,path=`episodes/${episode}_v${version}.mp4`,hash=await sha256(file),key='episode:'+uid();await storeBlob(key,file);await writeFile(folder,path,file);
    const record={id:episode,version,path,sha256:hash,blobKey:key,seconds:info.duration,inputs:fingerprints,createdAt:now(),fullDecode:'passed',review:jobs.every(j=>j.review==='approved')?'人工已审各镜，整集仍待审核':'整集内容待审核'};project.episodes.push(record);await writeFile(folder,`episodes/${episode}_v${version}_inputs.json`,JSON.stringify(record,null,2));this.event('episode_ready',`${episode} ${info.duration.toFixed(2)}秒，版本${version}`);await this.persist(true);return record;
  }
}
