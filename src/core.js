export const MODEL = 'agnes-video-2.5-flash';
export const ORIGINS = ['https://api.agnes-ai.cn', 'https://apihub.agnes-ai.com'];
export const DIMENSIONS = {'9:16':[720,1280],'16:9':[1280,704],'1:1':[720,720],'4:3':[960,720],'3:4':[720,960],'21:9':[1680,720]};
export const LABELS = {draft:'素材待检查',invalid:'素材需处理',pending:'审核通过 · 待提交',submitting:'正在提交',unknown:'提交结果待核实',queued:'服务端排队',generating:'生成中',deferred:'退避等待',download:'待下载',checking:'本地校验中',ready:'已生成 · 待内容审核',approved:'内容审核通过',needs_redo:'不合格待处理',failed:'生成失败',blocked:'需处理后继续'};
export const REMOTE_ACTIVE = new Set(['submitting','unknown','queued','generating','deferred','download','checking','blocked']);
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const escapeHTML = (v='') => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const safeName = (s) => String(s).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,100) || 'untitled';
export const safeID = (s) => typeof s==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s);
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=> !/^(apiKey|authorization|bridgeToken|password|key)$/i.test(k)).map(([k,v])=>[k,redact(v)]));
  if (typeof value==='string') return value.startsWith('data:') ? '[本地二进制素材，未导出]' : value.replace(/sk-[\w-]{12,}/g,'[密钥已隐藏]');
  return value;
}
export async function sha256(data) { const b=data instanceof Blob ? await data.arrayBuffer() : typeof data==='string' ? new TextEncoder().encode(data) : data; return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(n=>n.toString(16).padStart(2,'0')).join(''); }
export function nested(value,names) {
  if (!value || typeof value!=='object') return undefined;
  for (const name of names) if (value[name]!==undefined && value[name]!==null && value[name]!=='') return value[name];
  for (const name of ['data','video','result','output','error']) {const found=nested(value[name],names);if(found!==undefined)return found;}
}
export function cleanPrompt(s) {return String(s??'').replace(/\r\n/g,'\n').trim();}
export function validateJob(job, assets, allJobs=[]) {
  const errors=[],warnings=[];
  if(!safeID(job.id))errors.push('镜号只能使用字母、数字、短横线或下划线，最长64位，不能使用系统保留名。');
  if(!safeID(job.episode))errors.push('分组名称请使用字母、数字、短横线或下划线。');
  if(allJobs.some(j=>j.id===job.id && j.uid!==job.uid))errors.push('镜号重复，请使用新镜号或在原任务中修订。');
  if(!cleanPrompt(job.prompt))errors.push('请填写这一镜的画面与动作。');
  if((job.prompt||'').length>12000)errors.push('提示词超过本平台12000字限制，请精简到一个主要动作。');
  if(!Number.isInteger(Number(job.seconds)) || Number(job.seconds)<4 || Number(job.seconds)>12)errors.push('每镜只能是4–12秒的整数。请先拆分动作，不会自动截断剧情。');
  if(!DIMENSIONS[job.aspect])errors.push('画面比例不受支持。');
  if(!['text','reference','keyframe'].includes(job.mode))errors.push('请选择文字、参考或首尾帧模式。');
  if(job.seed!==null && job.seed!==undefined && job.seed!=='' && (!Number.isSafeInteger(Number(job.seed)) || Number(job.seed)<0 || Number(job.seed)>2147483647))errors.push('随机种子须为0–2147483647的整数。');
  const selected=(job.assetIds||[]).map(id=>assets.find(a=>a.id===id));
  if(selected.some(a=>!a))errors.push('以下参考素材尚未导入：'+(job.assetIds||[]).filter(id=>!assets.some(a=>a.id===id)).join('、')+'。请读取清单目录或在素材库补齐。');
  const images=selected.filter(a=>a?.kind==='image'),audios=selected.filter(a=>a?.kind==='audio');
  if(job.mode==='text' && (selected.length||job.firstFrame||job.lastFrame||job.continuityFrom))errors.push('文字模式不接受参考素材，请切换参考模式或移除素材。');
  if(job.mode==='reference'){
    if(job.firstFrame||job.lastFrame)errors.push('参考模式不接受首尾帧字段，请清除首尾帧或切换模式。');
    if(!selected.length&&!job.continuityFrom)errors.push('参考模式至少需要一张图或一段声音。');
    if(images.length+(job.continuityFrom?1:0)>5)errors.push('参考图最多5张，连续镜头的上一镜末帧也占1张。');
    if(audios.length>3)errors.push('参考声音最多3段。');
  }
  if(job.mode==='keyframe'){
    if(!job.firstFrame&&!job.lastFrame)errors.push('首尾帧模式至少选择一帧。');
    if(audios.length||job.continuityFrom)errors.push('首尾帧模式不能携带声音或连续镜头参考。');
    for(const id of [job.firstFrame,job.lastFrame].filter(Boolean))if(!assets.find(a=>a.id===id&&a.kind==='image'))errors.push('首尾帧图片尚未导入。');
  }
  const relevant=job.mode==='keyframe' ? [job.firstFrame,job.lastFrame].filter(Boolean).map(id=>assets.find(a=>a.id===id)).filter(Boolean) : selected.filter(Boolean);
  for(const a of relevant)if(a.errors?.length)errors.push(`${a.name}：${a.errors.join('；')}`);
  const seconds=audios.reduce((s,a)=>s+(a.duration||0),0);
  if(audios.length && (seconds<2 || seconds>12.001))errors.push(`声音合计 ${seconds.toFixed(2)} 秒，必须为2–12秒；请先裁切或减少声音。`);
  if(relevant.reduce((s,a)=>s+a.bytes*4/3,0)>48_000_000)errors.push('编码后的请求可能超过50MB，请缩小图片或裁短声音。');
  for(const [kind,count] of [['Picture',images.length+(job.continuityFrom?1:0)],['Audio',audios.length]]){
    for(const m of String(job.prompt).matchAll(new RegExp(`<${kind}\\s+(\\d+)>`,'gi')))if(Number(m[1])<1||Number(m[1])>count)errors.push(`<${kind} ${m[1]}> 没有对应素材，请核对顺序。`);
  }
  if(job.continuityFrom){const own=allJobs.findIndex(j=>j.id===job.id),previous=allJobs.findIndex(j=>j.id===job.continuityFrom);if(previous<0)errors.push('未找到上一镜；请把连续段按顺序一起导入。');else if(job.continuityFrom===job.id||(own>=0&&previous>=own))errors.push('衔接只能引用排在前面的镜头，不能引用自己或后面的镜头。');}
  if(images.some(a=> Math.abs(a.width/a.height-(DIMENSIONS[job.aspect]?.[0]/DIMENSIONS[job.aspect]?.[1]))>.7))warnings.push('场景与输出画幅差别较大：可能出现填充边；可在素材库制作独立构图版本，原图保持不变。');
  if((job.dialogue||'').length/Number(job.seconds)>5)warnings.push('对白可能过密。建议每秒不超过约5个汉字，并留出动作和停顿时间。');
  if(!job.dialogue)warnings.push('本镜无指定对白。平台会补充无对白约束，生成后仍需听审环境人声。');
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}
export {parseCSV,parseBatch} from './batch.js';
export function requestPrompt(job, count) {
  let p=cleanPrompt(job.prompt).split('\n\n【X-AI运行约束】')[0];
  p+='\n\n【X-AI运行约束】\n画面自然填满指定画幅，保持人物比例；不要复制参考图的白底、标签或拼贴排列。禁止黑边、模糊填充带、字幕、水印与对白气泡。';
  p+=job.dialogue?`\n只说以下指定对白，不念角色名或动作说明：${job.dialogue}`:'\n本镜没有对白：只生成相应环境与动作音效，不说话、不旁白、不歌唱，不播放参考试音内容。';
  if(job.continuityFrom)p+=`\n<Picture ${count}>是上一镜当前版本的末帧，请从此状态继续，不重复已经完成的动作。`;
  return p;
}
export function classifyHTTP(status, body, posting=false){
  const code=nested(body,['code']);
  if((status===429&&code==='rate_limit_exceeded')||(status===503&&code==='video_queue_full'))return 'deferred';
  if(posting && status>=500)return 'unknown';
  if([400,401,403,422].includes(status))return 'rejected';
  return posting?'unknown':'poll_error';
}
export function friendlyError(error){
  if(error?.xaiOperation==='output-write'&&['InvalidStateError','NoModificationAllowedError','NotReadableError','AbortError','WriteVerificationError'].includes(error.name)){const stage={open:'打开',write:'写入',close:'提交',verify:'核验'}[error.xaiStage];return '无法保存 '+(error.xaiPath||'目录记录')+(stage?'（'+stage+'阶段）':'')+'：'+(error.xaiAttempts?'已自动尝试 '+error.xaiAttempts+' 次，':'')+'目录文件暂不可写或状态变化。请重试保存或重新选择输出目录；浏览器记录保留。';}
  if(['InvalidStateError','NotReadableError'].includes(error?.name))return '原文件当前不可读取，可能已被移动、替换或占用。请重新选择原文件，再重试此项。';
  if(error?.name==='NotAllowedError')return '本地文件权限被拒绝，请重新授权文件夹。';
  if(error?.name==='QuotaExceededError')return '浏览器本地空间不足，请导出记录并腾出磁盘空间。';
  if(error?.name==='AbortError')return '请求超时或已取消；已有任务编号会保留。';
  if(error instanceof TypeError && /fetch|network/i.test(error.message))return '连接被网络或跨域拦截。可切换本机连接器，然后继续原任务。';
  return String(error?.message||error).replace(/sk-[\w-]{12,}/g,'[密钥已隐藏]').slice(0,220);
}
export function newJob(spec){return {...spec,uid:uid(),prompt:cleanPrompt(spec.prompt),seconds:Number(spec.seconds),state:'pending',attempts:[],current:null,createdAt:now(),updatedAt:now(),review:'pending'};}
export function makeProject(){return {schema:'x-ai-project-v1',id:uid(),name:'我的视频项目',createdAt:now(),updatedAt:now(),jobs:[],assets:[],episodes:[],events:[],settings:{origin:ORIGINS[0],connection:'direct',gap:90}};}
export function safeExternalURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export function validateProjectFile(p){
  const fail=()=>{throw Error('项目记录格式不正确或包含不安全字段。');};
  const path=v=>typeof v==='string'&&v.length<1000&&v.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!/[\\:\x00-\x1f]/.test(x));
  const key=v=>typeof v==='string'&&v.length<300&&!/[<>"'\x00-\x1f]/.test(v);
  const hashes=['sha256','rawSha256','lastFrameSha256'];
  const checkAttempt=(a,depth=0)=>{if(!a||depth>2||!Number.isInteger(a.number)||a.number<1)fail();if(a.url&&!safeExternalURL(a.url))fail();
    for(const name of ['path','rawPath','lastFramePath','frameDirectory'])if(a[name]&&!path(a[name]))fail();
    for(const name of ['blobKey','rawBlobKey','lastFrameKey'])if(a[name]&&!key(a[name]))fail();
    for(const name of hashes)if(a[name]&&!/^[a-f0-9]{64}$/.test(a[name]))fail();
    if(a.videoId&&(typeof a.videoId!=='string'||a.videoId.length>300))fail();
    if(a.frameKeys&&(!Array.isArray(a.frameKeys)||a.frameKeys.length>5||a.frameKeys.some(k=>!key(k))))fail();
    if(a.downloadHistory){if(!Array.isArray(a.downloadHistory)||a.downloadHistory.length>100)fail();a.downloadHistory.forEach(x=>checkAttempt(x,depth+1));}
  };
  if(p?.schema!=='x-ai-project-v1'||!safeID(p.id)||typeof p.name!=='string'||!Array.isArray(p.jobs)||p.jobs.length>1000||!Array.isArray(p.assets)||!Array.isArray(p.episodes)||!Array.isArray(p.events))fail();
  if(!ORIGINS.includes(p.settings?.origin)||!['direct','bridge'].includes(p.settings?.connection))fail();
  if(p.studios!==undefined){
    if(!Array.isArray(p.studios)||!p.studios.length||p.studios.length>100)fail();const studioIDs=new Set();
    for(const s of p.studios){if(!s||!safeID(s.id)||studioIDs.has(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>100||!Array.isArray(s.assetIds)||!Array.isArray(s.archivedAssetIds)||[...s.assetIds,...s.archivedAssetIds].some(id=>!p.assets.some(a=>a.id===id)))fail();studioIDs.add(s.id);
      if(s.draft!==null&&s.draft!==undefined){if(typeof s.draft!=='object'||Array.isArray(s.draft)||typeof s.draft.batchMode!=='boolean'||!s.draft.fields||typeof s.draft.fields!=='object'||Array.isArray(s.draft.fields)||Object.values(s.draft.fields).some(v=>typeof v!=='string'||v.length>10_000_000)||!Array.isArray(s.draft.selected)||!Array.isArray(s.draft.batchSelected)||[...s.draft.selected,...s.draft.batchSelected].some(id=>!p.assets.some(a=>a.id===id)))fail();}
    }if(!studioIDs.has(p.activeStudioId)||p.jobs.some(j=>j.studioId&&!studioIDs.has(j.studioId)))fail();
  }
  const ids=new Set(),uids=new Set(),assetIDs=new Set();let active=0;
  for(const j of p.jobs){if(!safeID(j.id)||!safeID(j.uid)||!safeID(j.episode)||ids.has(j.id)||uids.has(j.uid)||!Object.hasOwn(LABELS,j.state)||typeof j.prompt!=='string'||!Array.isArray(j.assetIds)||!Array.isArray(j.attempts)||!Number.isInteger(j.seconds)||j.seconds<4||j.seconds>12||!DIMENSIONS[j.aspect]||!['text','reference','keyframe'].includes(j.mode))fail();ids.add(j.id);uids.add(j.uid);
    if(j.progressKnown!==undefined&&typeof j.progressKnown!=='boolean')fail();
    if(j.textSources&&(!Array.isArray(j.textSources)||j.textSources.length>10000||j.textSources.some(s=>!s||!safeID(s.root)||!path(s.path)||!/^[a-f0-9]{64}$/.test(s.sha256)||typeof s.field!=='string'||typeof s.selection!=='string'||typeof s.encoding!=='string'||!Array.isArray(s.chain)||s.chain.length>12||s.chain.some(c=>typeof c!=='string'||c.length>2000))))fail();
    if(j.referenceReplacements&&(!Array.isArray(j.referenceReplacements)||j.referenceReplacements.length>2||j.referenceReplacements.some(r=>!r||!['prompt','dialogue'].includes(r.field)||typeof r.before!=='string'||typeof r.after!=='string')))fail();
    for(const a of [...j.attempts,...(j.current?[j.current]:[])])checkAttempt(a);
    if(['unknown','submitting','queued','generating','download','checking'].includes(j.state)||(j.attempts.at(-1)?.videoId&&!j.attempts.at(-1).resolved&&!j.attempts.at(-1).terminalConfirmed))active++;
  }
  if(active>1)throw Error('记录中存在多个未结束的远端任务，无法安全串行恢复。请先向服务商核实任务状态。');
  for(const a of p.assets){if(!safeID(a.id)||assetIDs.has(a.id)||typeof a.name!=='string'||!['image','audio'].includes(a.kind)||!Array.isArray(a.errors)||!Number.isFinite(a.bytes)||!path(a.path)||!key(a.blobKey)||!/^[a-f0-9]{64}$/.test(a.sha256))fail();
    if(a.storage!==undefined&&a.storage!=='source')fail();
    if(a.storage==='source'&&(!Array.isArray(a.sources)||!a.sources.length))fail();
    if(a.sources&&(!Array.isArray(a.sources)||a.sources.some(s=>!s||!safeID(s.root)||!path(s.path)||typeof s.rootName!=='string')))fail();
    if(a.aliases&&(!Array.isArray(a.aliases)||a.aliases.some(v=>typeof v!=='string'||v.length>1000)))fail();
    if(a.legacyPaths&&(!Array.isArray(a.legacyPaths)||a.legacyPaths.some(v=>!path(v))))fail();
    for(const name of ['diskPending','recordPending'])if(a[name]!==undefined&&typeof a[name]!=='boolean')fail();
    if(a.effectiveAssetId&&!p.assets.some(x=>x.id===a.effectiveAssetId&&x.derivedFrom===a.id))fail();assetIDs.add(a.id);}
  for(const e of p.episodes)if(!safeID(e.id)||!Number.isInteger(e.version)||!Number.isFinite(e.seconds)||!Array.isArray(e.inputs)||!path(e.path)||!key(e.blobKey))fail();
  p.settings.gap=Math.max(90,Math.min(3600,Number(p.settings.gap)||90));return p;
}
export function recordEvent(project,kind,message,jobId){project.events.push({at:now(),kind,message: redactedText(message),jobId});project.updatedAt=now();}
function redactedText(text){return typeof text==='string'?redact(text):JSON.stringify(redact(text));}
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function derive(password,salt,iterations){const raw=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
export async function encryptKey(key,password){if(password.length<12)throw Error('加密口令至少12位。');const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),iterations=310000;const derived=await derive(password,salt,iterations);const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},derived,new TextEncoder().encode(key));return {format:'x-ai-vault-v1',kdf:'PBKDF2-SHA256',iterations,salt:b64(salt),iv:b64(iv),cipher:b64(cipher)};}
export async function decryptKey(v,password){if(v?.format!=='x-ai-vault-v1'||v.kdf!=='PBKDF2-SHA256'||!Number.isInteger(v.iterations)||v.iterations<100000||v.iterations>1000000||typeof v.cipher!=='string'||v.cipher.length>20000)throw Error('保险箱格式不受支持。');try{const key=await derive(password,unb64(v.salt),v.iterations);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(v.iv)},key,unb64(v.cipher)));}catch{throw Error('口令不正确，或保险箱文件已损坏。');}}
