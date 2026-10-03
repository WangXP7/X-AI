import {QueueWatchdog} from './queue-watchdog.js';
import {APP_VERSION} from './runtime-version.js';
import {pacingKey,submissionGap} from './request-pacing.js';
import {migrateAutomaticQueue} from './queue-health.js';
import {recoverDownloads} from './download-recovery.js';
import {taskProblem,taskStatus} from './network.js';
import {DIMENSIONS,LABELS,now,uid,escapeHTML as h,safeID,sha256,redact,validateJob,parseBatch,newJob,recordEvent,friendlyError,requestPrompt,validateProjectFile,makeProject,safeExternalURL} from './core.js';
import {get,put,remove,loadProject,getFolder,chooseFolder,chooseMediaFiles,permitted,blob,storeBlob,readFile,writeFile,saveProject,downloadFile,reportMarkdown,existingProject,restoreProjectFiles,backupReferences,writeAssetFile} from './storage.js';
import {trimAudio,deepCheck} from './media.js';
import {Runner} from './engine.js';
import {CredentialsPanel} from './credentials.js';
import {AssetLibrary} from './assets.js';
import {BatchPanel} from './batch-panel.js';
import {effectiveAsset} from './batch.js';
import {ensureStudios,activeStudio,createStudio,studioAssets,currentStudioAssets,matchPromptAssets} from './studio.js';
import {installPlaybackController} from './playback.js';
import {QueuePanel} from './queue-panel.js';
import {promptSpec,reconcileDurationQA} from './prompt-spec.js';
import {MODEL_PROFILES,modelProfile,modelCapability,modelOptionLabel,UPCOMING_MODELS} from './models.js';
import {submissionCooldown,cooldownMessage,pendingSubmission} from './submission-policy.js';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
document.documentElement.dataset.runtimeVersion=APP_VERSION;
let project,folder,runner,credentials,assetLibrary,batchPanel,queuePanel,watchdog,batchMode=false,creationMode='single',experience='easy',selected=[],batchSelected=[],pavoSelected=[],exclusive=false,currentEdit=null,importTarget=null,renderId=0,queueLimit=60,selectedView='studio',directoryBusy=false,preparing=false,cooldownUpdating=false,lastPavoQueued=null,lastPavoPrompt='';
const urls=new Map();
const playback=installPlaybackController();
function toast(text,error=false){
  const dialog=$$('dialog[open]').at(-1);
  if(dialog?.id==='settings-dialog'&&credentials){credentials.feedback(text,error?'error':'info');return;}
  const div=document.createElement('div');div.className='toast'+(error?' error':'');div.setAttribute('role',error?'alert':'status');div.textContent=text;
  if(dialog){let region=dialog.querySelector('.dialog-notifications');if(!region){region=document.createElement('div');region.className='dialog-notifications';dialog.append(region);}region.replaceChildren(div);dialog.addEventListener('close',()=>region.remove(),{once:true});}
  else{$('#toast-region').append(div);setTimeout(()=>div.remove(),7000);}
}
function run(fn){return async event=>{try{if(!exclusive)throw Error('另一个X-AI页面已打开。请关闭另一页后刷新本页，避免多个队列同时运行。');await fn(event);}catch(e){toast(friendlyError(e),true);}};}
function on(id,event,fn){$(id).addEventListener(event,run(fn));}
const draftFields=['shot-id','episode','prompt','generation-mode','seconds','aspect','dialogue','seed','first-frame','last-frame','batch-input','batch-seconds','batch-aspect','batch-episode','batch-id-prefix','pavo-prompt','pavo-aspect','pavo-seconds','pavo-generation-mode','video-model','pavo-model'];
let draftTimer;
function captureDraft(){if(!project?.studios)return;activeStudio(project).draft={batchMode,creationMode,pavoDefaultsVersion:'1.2.1',fields:Object.fromEntries(draftFields.map(id=>[id,$('#'+id).value])),selected:[...selected],batchSelected:[...batchSelected],pavoSelected:[...pavoSelected],continuity:$('#continuity').checked};}
async function save(){captureDraft();await saveProject(project,folder);await render();}
function event(kind,message,id){recordEvent(project,kind,message,id);}
async function localURL(key){if(!urls.has(key))urls.set(key,URL.createObjectURL(await blob(key)));return urls.get(key);}
function clearURL(key){if(urls.has(key)){URL.revokeObjectURL(urls.get(key));urls.delete(key);}}
function view(name){playback.pauseAll();selectedView=name;$$('.view').forEach(v=>v.hidden=v.id!==name+'-view');$$('.nav[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$('#view-label').textContent={studio:'创作工作台',queue:'任务与成片',assets:'本地素材库',guide:'操作指南'}[name];if(name==='assets')renderAssets();if(name==='queue')queuePanel?.update();window.scrollTo({top:0,behavior:'instant'});}
function updateConnection(){const enabled=!!runner.transport.key;$('#key-dot').classList.toggle('on',enabled);$('#connection-status').classList.toggle('connected',enabled);$('#connection-status').innerHTML='<i></i>'+(enabled?(credentials?.activeLabel||'密钥')+'已启用':'未启用密钥');$('#connection-status').title=enabled?'已启用密钥，不代表 API 连接已验证。打开连接设置可检查。':'点击设置默认密钥或自己的密钥';}

async function showSettings(){$('#connection-mode').value=project.settings.connection;$('#api-origin').value=project.settings.origin;$('#request-gap').value=submissionGap(project.settings,modelProfile());$('#bridge-settings').hidden=project.settings.connection!=='bridge';await credentials.open();}
function singleDefaults(){return {profileId:$('#video-model').value,id:$('#shot-id').value.trim(),episode:$('#episode').value.trim(),prompt:$('#prompt').value.trim(),seconds:Number($('#seconds').value),mode:$('#generation-mode').value,aspect:$('#aspect').value,dialogue:$('#dialogue').value.trim(),seed:$('#seed').value===''?null:Number($('#seed').value),assetIds:[...selected],firstFrame:$('#first-frame').value||null,lastFrame:$('#last-frame').value||null};}
function batchDefaults(){return {profileId:$('#video-model').value,id:$('#batch-id-prefix').value.trim()||'S01',episode:$('#batch-episode').value.trim()||'EP01',prompt:'',seconds:Number($('#batch-seconds').value),mode:batchSelected.length?'reference':'text',aspect:$('#batch-aspect').value,dialogue:'',seed:null,assetIds:[...batchSelected],firstFrame:null,lastFrame:null};}
const simplified=()=>experience==='easy'||creationMode==='pavo';
function pavoDefaults(){const aspect=$('#pavo-aspect').value,first=pavoSelected.map(id=>project.assets.find(a=>a.id===id)).find(a=>a?.kind==='image');const auto=first?Object.keys(DIMENSIONS).reduce((best,a)=>Math.abs(first.width/first.height-DIMENSIONS[a][0]/DIMENSIONS[a][1])<Math.abs(first.width/first.height-DIMENSIONS[best][0]/DIMENSIONS[best][1])?a:best,'16:9'):'16:9';return {...singleDefaults(),profileId:$('#pavo-model').value,prompt:$('#pavo-prompt').value.trim(),seconds:Number($('#pavo-seconds').value),aspect:aspect==='Auto'?auto:aspect,mode:$('#pavo-generation-mode').value,dialogue:'',seed:null,assetIds:[...pavoSelected],firstFrame:null,lastFrame:null};}
function defaults(){return batchMode?batchDefaults():creationMode==='pavo'?pavoDefaults():singleDefaults();}
function activeReferences(){return batchMode?batchSelected:creationMode==='pavo'?pavoSelected:selected;}
function updatePavoSettings(){for(const b of $$('[data-pavo-aspect]'))b.setAttribute('aria-pressed',String(b.dataset.pavoAspect===$('#pavo-aspect').value));for(const b of $$('[data-pavo-seconds]'))b.setAttribute('aria-pressed',String(b.dataset.pavoSeconds===$('#pavo-seconds').value));$('#pavo-settings-summary').textContent=`${$('#pavo-aspect').value}　${$('#pavo-seconds').value}s　${modelProfile($('#pavo-model').value).resolution.toLowerCase()}`;}
function updateModelUI(){
  const d=defaults(),{profile,minSeconds,maxSeconds,step}=modelCapability(d.profileId,d.mode);
  for(const el of $$('[data-current-platform]'))el.textContent=profile.platformName;
  $('.workspace-limit').textContent=`${profile.platformName} 此模式请求 ${minSeconds}–${maxSeconds} 秒 · 生成提交间隔 ${submissionGap(project.settings,profile)} 秒`;
  const opt=$('#video-model').selectedOptions[0];if(opt){opt.textContent=modelOptionLabel($('#video-model').value,batchMode?batchDefaults().mode:$('#generation-mode').value);$('#video-model').title=opt.textContent;$('#video-model-mobile-info').textContent=opt.textContent;}
  for(const [id,profileId,mode] of [['seconds',$('#video-model').value,$('#generation-mode').value],['batch-seconds',$('#video-model').value,batchDefaults().mode]]){const c=modelCapability(profileId,mode),el=$('#'+id),old=el.value,values=[];for(let n=c.minSeconds;n<=c.maxSeconds;n+=c.step)values.push(n);if(el.options.length!==values.length||[...el.options].some((o,i)=>Number(o.value)!==values[i])){el.innerHTML=values.map(n=>`<option>${n}</option>`).join('');el.value=values.includes(Number(old))?old:String(c.maxSeconds);}}
  $('.tip-card>div').innerHTML=`${h(profile.platformName)} 此模式请求 ${minSeconds}–${maxSeconds} 秒 <b>单任务串行</b>`;
  const p=modelCapability($('#pavo-model').value,$('#pavo-generation-mode').value),row=$('#pavo-duration-options'),values=[];for(let n=p.minSeconds;n<=p.maxSeconds;n+=p.step)values.push(n);if(!values.includes(Number($('#pavo-seconds').value)))$('#pavo-seconds').value=p.minSeconds;
  row.innerHTML=values.map(n=>`<button type="button" data-pavo-seconds="${n}">${n}s</button>`).join('');$('.pavo-resolution').textContent=p.profile.resolution;$('.pavo-settings small').textContent=`提示词明确时长优先；${p.profile.platformName} 此模式请求最多 ${p.maxSeconds} 秒，较长返回原片直接采用。`;
  $('.pavo-caption').textContent=`全能模式 = 图片 / 声音参考。使用 ${p.profile.platformName} 生成，X-AI 自动完成检查、下载和保存。`;updatePavoSettings();
}
async function updateSubmissionControls(){
  if(!project||cooldownUpdating)return;cooldownUpdating=true;
  try{const d=defaults(),profile=modelProfile(d.profileId),stored=await get('state','submission-cooldowns')||{},rate=await get('state',pacingKey(profile.platformId||profile.id,'submit'))||{};runner.cooldowns=stored;runner.rate=rate;const c=submissionCooldown(project,d.profileId,stored),blocked=simplified()&&c.remaining>0;
    const notice=$('#submission-cooldown');notice.hidden=!blocked;notice.textContent=blocked?`${c.platformName} 提交冷却还剩 ${c.remaining} 秒；提示词和素材照常接收，点击发送后进入待提交队列。`:'';
    for(const id of ['add-jobs','pavo-submit']){$('#'+id).disabled=preparing;$('#'+id).title=blocked?'接收并排队，冷却后自动提交':'发送创作任务';}
    const current=project.jobs.find(j=>j.uid===lastPavoQueued&&['pending','deferred','submitting','unknown','queued','generating','download','checking','blocked'].includes(j.state));
    const draft=lastPavoPrompt===$('#pavo-prompt').value.trim()&&current?current:{...d,uid:'current-draft'};const position=pendingSubmission(project,draft,runner,stored,rate);
    $('#pavo-reference-count').textContent=draft===current?`队列第 ${position.position} 位`:`将排第 ${position.position} 位`;$('#pavo-reference-count').title=position.message;
  }finally{cooldownUpdating=false;}
}
function applyExperience(){document.body.dataset.experience=experience;for(const id of ['shot-id','episode'])$('#'+id).required=!simplified();for(const value of ['easy','expert'])$('#experience-'+value).setAttribute('aria-pressed',String(experience===value));$('#experience-description').textContent=experience==='easy'?'填入提示词、添加素材，点击生成。其余交给 X-AI。':'完整参数、素材处理和队列操作，由你逐项控制。';$('#add-jobs').innerHTML=simplified()?'生成视频 <span>→</span>':batchMode?'检查整批并加入队列 <span>→</span>':'检查并加入队列 <span>→</span>';}
function updateBatchDefaultsSummary(){const d=batchDefaults();$('#batch-defaults-summary').textContent=`${d.seconds} 秒 · ${d.aspect} · ${d.episode} · ${batchSelected.length?batchSelected.length+' 项共用素材':'无共用素材'}`;}
function updateMode(){const keyframe=$('#generation-mode').value==='keyframe';$('#keyframe-fields').hidden=!keyframe;if(!keyframe){$('#first-frame').value='';$('#last-frame').value='';}updateModelUI();}
async function renderSelected(){
  const effective=ids=>[...new Set(ids.map(id=>{const asset=project.assets.find(a=>a.id===id),original=project.assets.find(a=>a.id===asset?.derivedFrom);return effectiveAsset(original?.effectiveAssetId?original:asset,project.assets)?.id||id;}))];
  selected=effective(selected);batchSelected=effective(batchSelected);pavoSelected=effective(pavoSelected);$('#studio-library-count').textContent=currentStudioAssets(project).length;$('#pavo-reference-count').title='当前草稿提交后的队列位置';
  for(const [mode,ids,target] of [['single',selected,'selected-assets'],['batch',batchSelected,'batch-selected-assets'],['pavo',pavoSelected,'pavo-selected-assets']]){
    const items=ids.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean);
    $('#'+target).innerHTML=items.map(a=>`<div class="asset-chip">${a.kind==='image'?`<img data-asset-thumb="${a.id}" alt="">`:'♫'}<span>${h(a.name.length>25?a.name.slice(0,22)+'…':a.name)}</span><button type="button" data-unselect="${a.id}" data-reference-mode="${mode}" aria-label="移除参考素材">×</button></div>`).join('');
  }
  for(const el of $$('[data-asset-thumb]')){const a=project.assets.find(a=>a.id===el.dataset.assetThumb);el.src=await localURL(a.blobKey);}
  for(const id of ['first-frame','last-frame']){const old=$('#'+id).value;$('#'+id).innerHTML='<option value="">不设置</option>'+currentStudioAssets(project).filter(a=>a.kind==='image').map(a=>`<option value="${a.id}">${h(a.name)}</option>`).join('');$('#'+id).value=effectiveAsset(project.assets.find(a=>a.id===old),project.assets)?.id||old;}
  updateBatchDefaultsSummary();updateModelUI();
}
async function planImport(files,options={}){assetLibrary.planImport(files,options);if(files.length&&simplified()){await assetLibrary.execute();const invalid=assetLibrary.resultAssets().filter(a=>a.kind==='image'&&a.errors?.length);if(invalid.length&&!assetLibrary.retry.length&&!assetLibrary.remaining.length){assetLibrary.planOptimize(invalid);await assetLibrary.execute();}if(!assetLibrary.retry.length&&!assetLibrary.remaining.length&&!assetLibrary.results.some(r=>r.state==='warning')&&$('#asset-operation-feedback').hidden)assetLibrary.close();}}
async function importFiles(files,reference=true){return planImport(files,{reference});}
async function pickAssets(reference=false){ensureDraftReady();try{const picked=await chooseMediaFiles();if(picked)await planImport(picked.files,{metadata:picked.metadata,reference});else $('#'+(reference?'asset-files':'library-files')).click();}catch(e){if(e.name!=='AbortError')throw e;}}
async function useReferences(ids,{importing=false}={}){
  const next=[...new Set([...activeReferences(),...ids].map(id=>effectiveAsset(project.assets.find(a=>a.id===id),project.assets)?.id||id))],assets=next.map(id=>project.assets.find(a=>a.id===id)).filter(Boolean);
  const images=assets.filter(a=>a.kind==='image'),audios=assets.filter(a=>a.kind==='audio'),refs=modelProfile(defaults().profileId).references;
  if(images.length>refs.maxImages||audios.length>refs.maxAudio||audios.reduce((n,a)=>n+a.duration,0)>refs.maxAudioSeconds+.001){
    const message=`此模型最多 ${refs.maxImages} 张图片、${refs.maxAudio} 段声音，声音合计不超过 ${refs.maxAudioSeconds} 秒。请减少勾选，或先移除当前分镜的部分参考。`;
    if(importing)return '素材已导入素材库，尚未加入当前分镜。'+message;
    throw Error(message);
  }
  if(batchMode){batchSelected=next;$('#batch-defaults').open=true;}else if(creationMode==='pavo'){pavoSelected=next;$('#pavo-generation-mode').value='reference';}else{selected=next;$('#generation-mode').value='reference';updateMode();}
  await renderSelected();await renderAssets();
  captureDraft();await saveProject(project,folder);
  if(!importing)toast(batchMode?`已设为批量共用素材，仅补齐未写素材列的分镜。`:`已将 ${ids.length} 项素材用于当前分镜。`);
  return '';
}

async function render(){await updateSubmissionControls();
  if(!project)return;const id=++renderId,ready=project.jobs.filter(j=>['ready','approved'].includes(j.state)).length,total=project.jobs.length;$('#nav-count').textContent=total;$('#ready-count').textContent=String(ready).padStart(2,'0');$('#total-count').textContent=String(total).padStart(2,'0');$('#overall-progress').style.width=(total?ready/total*100:0)+'%';
  if(!folder){$('#directory-name').textContent='连接一个本地文件夹';$('#directory-desc').textContent='素材、视频和记录保存在本地';$('#restore-folder').hidden=true;}
  if(folder){$('#directory-name').textContent=folder.name;const granted=await permitted(folder);$('#directory-desc').textContent=granted?'已授权 · 文件自动保存到此目录':'文件夹已记住，开始前请重新授权。';$('#restore-folder').hidden=granted;}
  $('#directory-details').hidden=!folder;if(folder){$('#directory-location-label').textContent=folder.name+' /';$('#directory-path-note').textContent='保存到你刚选择的 '+folder.name+' 文件夹。浏览器不提供完整盘符路径；如需确认，请点击“选择文件夹”查看系统选择窗口。';}$('#studio-library-count').textContent=currentStudioAssets(project).length;
  $('#studio-project-name').textContent=activeStudio(project).name;$('#workspace-pending').textContent=total-ready;$('#workspace-ready').textContent=`${ready} / ${total}`;$('#workspace-assets').textContent=currentStudioAssets(project).length;
  const active=project.jobs.find(j=>['submitting','queued','generating','deferred','checking','download','unknown','blocked'].includes(j.state));const mini=active?[active,...project.jobs.filter(j=>j!==active).slice(-2).reverse()]:project.jobs.slice(-3).reverse();
  $('#mini-jobs').innerHTML=mini.length?mini.map(j=>`<div class="mini-row"><span class="mini-icon">${['ready','approved'].includes(j.state)?'▷':'◌'}</span><div><strong>${h(j.id)} <small>${j.seconds}s · ${h(j.episode)}</small></strong></div><span class="status ${j.state}">${h(taskStatus(j)||LABELS[j.state]||j.state)}</span></div>`).join(''):'<div class="empty-mini"><span>◌</span><p>下一部作品，从第一镜开始。</p></div>';
  $('#pause-queue').textContent=runner.pauseNew?'已暂停新提交':'暂停新提交';queuePanel?.update();
  const filter=$('#queue-filter').value;let jobs=project.jobs.filter(j=>filter==='all'||filter==='ready'&&['ready','approved'].includes(j.state)||filter==='pending'&&['pending','invalid','deferred'].includes(j.state)||filter==='active'&&['submitting','queued','generating','download','checking'].includes(j.state)||filter==='attention'&&['unknown','blocked','failed','needs_redo','invalid'].includes(j.state));
  const allCount=jobs.length;jobs=jobs.slice(0,queueLimit);$('#jobs-grid').innerHTML=jobs.length?jobs.map(j=>`<article class="job-card"><div class="job-preview">${j.current?.blobKey?`<video data-video="${h(j.current.blobKey)}" controls playsinline preload="none"></video>`:`<span>${['queued','generating'].includes(j.state)?'◌':'▷'}</span><small>${h(j.seconds)} SEC / ${h(j.aspect)}</small>`}</div><div class="job-card-body"><div class="job-card-head"><h3>${h(j.id)}</h3><span class="status ${j.state}">${h(taskStatus(j)||LABELS[j.state]||j.state)}</span></div><p class="job-prompt">${h(j.prompt)}</p><div class="job-meta"><span>${h(j.episode)}</span><span>${h(j.studioName||'原有项目')}</span><span>${j.current?.qa?.duration?j.current.qa.duration.toFixed(2)+' 秒（实际）':j.seconds+' 秒（请求）'}</span><span>${h(j.aspect)}</span><span>V${j.attempts.length||1}</span></div><div class="job-live-progress" data-job-progress="${j.uid}"><div><span>${h(taskStatus(j)||LABELS[j.state]||j.state)}</span><b></b></div><progress max="100" aria-label="${h(j.id)} 当前处理阶段"></progress></div>${j.error?`<div class="job-error">${h(taskProblem(j).message||j.error)}</div>`:''}<div class="job-actions"><button class="button secondary" data-detail="${j.uid}">详情与操作 ↗</button>${j.current?`<button class="button secondary" data-save-video="${j.uid}">下载</button>`:taskProblem(j).downloadPending?`<span>程序自动恢复原视频下载</span>`:''}</div></div></article>`).join(''):'<div class="empty-state">这里还没有任务。先创建一镜，或导入你的分镜清单。</div>';
  if(allCount>queueLimit)$('#jobs-grid').insertAdjacentHTML('beforeend','<button class="button secondary" id="more-jobs">显示更多任务</button>');
  for(const el of $$('[data-video]')){try{const src=await localURL(el.dataset.video);if(id===renderId)el.src=src;}catch{el.closest('.job-preview').innerHTML='<small>文件未载入，请在详情中恢复本地文件。</small>';}}
  const groups=[...new Set(project.jobs.map(j=>j.episode))];$('#episodes-list').innerHTML=groups.map(ep=>{const shots=project.jobs.filter(j=>j.episode===ep),r=shots.filter(j=>['ready','approved'].includes(j.state)).length;const film=project.episodes.filter(e=>e.id===ep).at(-1);const stale=film&&film.inputs.some(i=>project.jobs.find(j=>j.id===i.id)?.current?.sha256!==i.sha256);return `<div class="episode-row"><div><strong>${h(ep)}</strong><small>${r}/${shots.length} 镜 · 计划 ${shots.reduce((s,j)=>s+j.seconds,0)} 秒${film?` · 已拼接 V${film.version}${stale?' · 镜头已更新，需重拼':''}`:''}</small></div><div class="inline-actions">${film?`<button class="button secondary small" data-episode-play="${ep}">查看成片</button>`:''}<button class="button secondary small" data-assemble="${ep}" ${r!==shots.length||runner.running||runner.refreshing||runner.assembling?'disabled':''}>${film?'重新拼接':'本地拼接'} →</button></div></div>`;}).join('');updateConnection();queuePanel?.update();
}
async function renderAssets(){if(assetLibrary)await assetLibrary.render();}

async function openDetail(job){
  const a=job.attempts.at(-1),cur=job.current;$('#detail-title').textContent=job.id+' · '+(taskStatus(job)||LABELS[job.state]);
  $('#detail-body').innerHTML=`<div class="detail-grid"><div>${cur?'<video id="detail-video" controls playsinline preload="metadata"></video><div id="detail-filmstrip" class="filmstrip"></div>':'<div class="empty-state">'+h(job.state==='download'?(a?.downloadWaitingFor==='browser-permission'?'等待浏览器允许本机访问，原任务已保留':a?.downloadWaitingFor?'等待下载通道恢复，程序每30秒自动检测':'程序正在自动下载并校验原视频'):taskProblem(job).message||'视频尚未生成')+'</div>'}<h3>提示词</h3><p>${h(job.prompt)}</p><h3>指定对白</h3><p>${h(job.dialogue||'无指定对白')}</p><h3>本地核验</h3><p>${cur?.qa?.fullDecode==='passed'?'完整解码通过':'完整解码尚未通过 / 未执行'} · 人工内容审核：${h(job.review||'pending')}</p><ul>${[...(cur?.qa?.fatal||[]),...(cur?.qa?.warnings||[]),'人物、口型、对白发音与剧情表达需看听审核，程序未作内容判定。'].map(s=>'<li>'+h(s)+'</li>').join('')}</ul></div><div><h3>任务操作</h3><div class="inline-actions wrap">${cur?`<button class="button secondary" data-save-video="${job.uid}">下载当前视频</button><button class="button secondary" data-recheck="${job.uid}">重新深度校验</button><button class="button secondary" data-review-pass="${job.uid}">确认内容审核通过</button><button class="button secondary" data-review-fail="${job.uid}">标记不合格</button>`:''}${a?.videoId&&!a?.terminalConfirmed?`<button class="button secondary" data-resume-job="${job.uid}">继续查询原任务</button>`:''}${experience==='expert'&&safeExternalURL(a?.url)?`<button class="button secondary" data-retry-download="${job.uid}">重新下载</button><a class="button secondary" target="_blank" rel="noopener" href="${h(a.url)}">在浏览器打开源视频</a>`:''}${experience==='expert'&&a?`<button class="button secondary" data-manual-import="${job.uid}">导入已下载视频</button>`:''}${['unknown','submitting'].includes(job.state)?`<button class="button secondary" data-bind-id="${job.uid}">绑定已找到的 video_id</button><button class="button secondary" data-confirm-uncreated="${job.uid}">已核实未创建任务</button>`:''}${!['unknown','submitting','queued','generating','download','checking','deferred'].includes(job.state)?`<button class="button primary" data-edit-job="${job.uid}">${job.attempts.length?'修订并准备重做':'编辑分镜'}</button>`:''}<button class="button secondary" data-review-prompt="${job.uid}">导出AI复核提示词</button></div>${experience==='expert'?`<button class="button secondary" data-download-help="${job.uid}">连接与下载帮助</button>`:''}<h3>接口记录</h3><p>video_id：${h(a?.videoId||'尚未返回')}</p><pre>${h(JSON.stringify(redact(a?.pollResponse||a?.response||a?.submitError||{}),null,2))}</pre><h3>历史版本</h3>${job.attempts.map((v,i)=>`<div class="history-row"><span>V${v.number} · ${h(v.reason||'')}<br><small>${v.path?h(v.path):h(v.videoId||'尚未创建')}</small></span>${v.blobKey?`<button class="button secondary small" data-history="${job.uid}:${i}">查看 / 设为当前</button>`:''}</div>`).join('')||'<p>尚无生成尝试</p>'}</div></div>`;
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();if(cur){try{$('#detail-video').src=await localURL(cur.blobKey);for(const key of cur.frameKeys||[]){const img=document.createElement('img');img.src=await localURL(key);img.alt='抽帧检查';$('#detail-filmstrip').append(img);}}catch(e){toast(friendlyError(e),true);}}
}
function lookup(value){const job=project.jobs.find(j=>j.uid===value);if(!job)throw Error('任务未找到。');return job;}
function hasUnresolved(){return project.jobs.some(j=>['unknown','submitting','queued','generating','deferred','download','checking'].includes(j.state)||(j.attempts.at(-1)?.videoId&&!j.attempts.at(-1).resolved&&!j.attempts.at(-1).terminalConfirmed));}
function ensureDraftReady(){if(directoryBusy)throw Error('目录正在连接或备份，请稍候。');if(assetLibrary?.busy||batchPanel?.busy)throw Error('素材正在处理，请等待完成。');if(runner?.refreshing||runner?.assembling)throw Error('正在刷新或拼接，请稍候。');}
function ensureIdle(){if(directoryBusy)throw Error('目录正在备份或连接，请稍候。');if(assetLibrary?.busy||batchPanel?.busy)throw Error('素材仍在处理中，请等待完成，或先停止当前批量操作。');if(runner.refreshing||runner.assembling)throw Error('正在刷新或拼接，请等待当前操作完成。');if(runner.running||runner.localChecks.size)throw Error('请先暂停新提交，并等待当前任务完成后再修改记录。');}
async function newAsset(asset){assetLibrary.mode='optimize';const issue=await assetLibrary.commit(asset);await save();await renderAssets();await renderSelected();if(batchPanel&&$('#batch-input').value.trim())batchPanel.preview();toast(issue||'已同名另存优化版本，原文件保留；素材替代关系已记录。',!!issue);}
async function mirrorAllFiles(folder){
  for(const a of project.assets)await writeAssetFile(folder,a,project);
  for(const j of project.jobs)for(const a of j.attempts.flatMap(a=>[a,...(a.downloadHistory||[])])){
    if(a.blobKey&&a.path)await writeFile(folder,a.path,await blob(a.blobKey));
    if(a.rawBlobKey&&a.rawPath){try{await writeFile(folder,a.rawPath,await blob(a.rawBlobKey));}catch{throw Error(j.id+'原始文件缺失，请从原项目文件夹恢复。');}}
    if(a.lastFrameKey)await writeFile(folder,a.lastFramePath,await blob(a.lastFrameKey));
    for(let i=0;i<(a.frameKeys||[]).length;i++)await writeFile(folder,`${a.frameDirectory||`checks/${j.id}_v${a.number}`}/frame_${i+1}.jpg`,await blob(a.frameKeys[i]));
    if(a.qa)await writeFile(folder,`${a.frameDirectory||`checks/${j.id}_v${a.number}`}/report.json`,JSON.stringify(a.qa,null,2));
  }
  for(const ep of project.episodes)await writeFile(folder,ep.path,await blob(ep.blobKey));
}
function guide(){const parts=[
 ['01 / 首次使用','<ol><li>用桌面版 Chrome 或 Edge 打开网页，选择本地输出文件夹并授权。</li><li>本机默认密钥会自动启用。打开“连接与密钥”可直接填入自己的 API 密钥并点击“使用新密钥”。加密保存、口令和备份在“高级模式”中。</li><li>检查连接。如跨域拦截，运行本机连接器，填入配对码并切换调用方式。</li><li>编排单镜或批量清单，检查后入队，再到任务页点击开始。</li></ol>'],
 ['02 / 素材与提示词','<p>添加素材时先显示校验清单，再逐项显示进度。素材库可多选批量优化图片或下载 ZIP；图片点击查看全图、原始尺寸与缩放。声音裁切需单独指定范围，清单原路径素材不会复制；优化合格后自动记住替代关系，新分镜与未提交分镜使用优化版，已生成历史保留。</p><p>参考图片最多5张，声音最多3段；声音总长2–12秒，单文件小于15MB。图片宽高256–5760像素，宽高比0.4–2.5。</p><p>素材库可以另存尺寸优化图和裁切声音。低清图片被放大不会恢复细节；角色身份、情节拆分、音色克隆不能靠规则修正，请用创作工具处理后再导入。</p><p>在参考模式用 <code>&lt;Picture 1&gt;</code>、<code>&lt;Audio 1&gt;</code> 按已选素材顺序标明用途。台词和动作说明分开写，避免模型朗读动作说明。</p>'],
 ['03 / 稳定批量生成','<p>请求时长遵循当前平台、模型和模式的能力配置；返回较长成片直接采用。只有生成提交默认间隔61秒，查询通常每10秒一次，完成后立即下载，远端同时只允许一个任务在途；原片完整保存后，下一独立镜头可以继续，技术校验在后台完成。正常排队不加罚；429等限流使间隔小步增加，恢复后逐步回落。保持页面与电脑唤醒；系统休眠时浏览器不能后台保证运行。</p><p>页面启动、每30秒、恢复显示及网络恢复时自动自检接续。入队成功清空本轮输入，失败保留。目录权限或密钥缺失时保留队列，必要条件恢复后接续。提交超时没有video_id时，必须在服务商控制台核实；绑定找到的编号，或确认根本没创建。严禁为赶进度盲重发。</p><p>本平台的单任务锁覆盖同一浏览器同一网站。请停止其他使用同一账户的生成程序；多个设备的RPM无法由静态网页统一约束。</p>'],
 ['04 / 校验、修订和拼接','<p>下载后检查MP4、时长、分辨率、比例、SHA-256、五点抽帧及完整解码。暗画面只是提醒，不自动当坏片。没有在此版本内置Whisper：指定台词只供人工听审和导出外部AI复核。</p><p>先重试下载或重新校验，再决定是否修订提示词重做。每次重做会产生新任务，历史文件保留。连续镜使用前镜当前版本末帧，更新前镜后需要复核后镜。</p><p>各镜技术通过后按组本地拼接MP4，统一24fps、48k音频；整集再次完整解码。单次拼接输入上限450MB；超出请分组或交给本地FFmpeg。</p>'],
 ['06 / 创作项目、素材筛选与试听','<p>“全新项目”和“项目选择”切换独立草稿与素材库，任务与成片仍显示当前制作记录的全部任务。各项目共用已选择的输出目录；镜号与拼接分组保持全局唯一。</p><p>提示词写入完整素材文件名后，点“自动关联素材库”可匹配当前有效版本；不同来源同名时改用准确路径。素材库按版本、图片/声音、校验状态和名称筛选；默认隐藏已替代原图，清空后可恢复。</p><p>声音试听、任务卡片和预览窗口同时只播放一段。播放新段自动暂停旧段，关闭预览或切换页面也会暂停。</p>'],
 ['05 / 文件和密钥','<p>本地目录含 <code>project.json</code>、<code>references/</code>、<code>raw/</code>、<code>clips/</code>、<code>checks/</code>、<code>episodes/</code>。浏览器保存工作副本，项目目录是可迁移备份。</p><p>本机默认密钥即开即用，私有配置不加入 Git 或公开网页。新密钥默认只在本次打开期间有效。需要加密保存与迁移时，展开高级模式设置口令；忘记口令需重新输入密钥。</p><p>生成需要把本镜提示词和所选参考素材发送给当前选择的视频生成平台，结果再下载到本地；不是离线模型推理。</p>'],
 ['06 / 常见恢复操作','<ul><li>跨域失败：切换本机连接器。Pages网址须用 <code>--origin https://你的用户名.github.io</code> 放行；允许浏览器“本地网络访问”权限。</li><li>已生成视频自动恢复：本地版使用同源通道，指定Pages来源自动连接已启动的本机媒体服务，无需逐个配对或导入。浏览器首次询问本地网络访问时允许一次；服务和网页均需1.2.6。服务暂不可用时30秒后复查，保留原video_id，不重复生成。</li><li>素材缺失：选择原项目文件夹，确认恢复已有项目。不要仅复制JSON。</li><li>完整解码失败：保留原文件，重新下载确认。依然失败再修订为新版本。</li><li>字幕、人物变形、台词错配：标记不合格，写明原因，导出AI复核提示词。</li></ul><a href="./README.md" target="_blank" rel="noopener">查看完整说明与 GitHub Pages 发布方法 ↗</a>']];$('#guide-content').innerHTML=parts.map(([title,body])=>`<article class="guide-section"><h2>${title}</h2>${body}</article>`).join('');}

async function init(){
  if(!window.isSecureContext||!navigator.locks||!crypto.subtle){document.body.innerHTML='<main style="margin:40px"><h1>请通过 localhost 或 HTTPS 打开 X-AI</h1><p>双击“启动X-AI.cmd”，启动工具会自动打开正确的本地地址。推荐桌面版 Chrome / Edge。</p></main>';return;}
  exclusive=await new Promise((resolve,reject)=>navigator.locks.request('x-ai-studio-tab',{ifAvailable:true},lock=>{resolve(!!lock);if(lock)return new Promise(()=>{});}).catch(reject));
  if(!exclusive){document.body.innerHTML='<main class="locked-page"><img src="./assets/logo.svg" alt="X-AI"><h1>另一个 X-AI 页面正在使用</h1><p>本页未载入或修改项目。请关闭另一页，再刷新继续。</p><button class="button primary" id="reload-exclusive">重新连接</button></main>';document.querySelector('#reload-exclusive').addEventListener('click',()=>location.reload());return;}
  project=validateProjectFile(await loadProject());folder=await getFolder();let newerDiskIssue;
  if(folder&&await permitted(folder)){try{const disk=await existingProject(folder);if(disk?.id===project.id&&Date.parse(disk.updatedAt)>Date.parse(project.updatedAt)){project=await restoreProjectFiles(disk,folder);}}catch(error){newerDiskIssue=error;folder=null;}}
  const upgraded=reconcileDurationQA(project);if(upgraded)recordEvent(project,'duration_rule_updated','1.2.0：已完整解码的原片直接采用，移除旧12秒时长误判。');
  for(const id of ['video-model','pavo-model'])$('#'+id).innerHTML=MODEL_PROFILES.map(p=>`<option value="${p.id}">${h(id==='pavo-model'?p.modelLabel:modelOptionLabel(p.id))}</option>`).join('')+UPCOMING_MODELS.map(p=>`<option value="${p.id}" disabled>${h(p.label)}</option>`).join('');
  experience=await get('state','experience')||'easy';if(!['easy','expert'].includes(experience))experience='easy';applyExperience();
  ensureStudios(project);const migrated=migrateAutomaticQueue(project);if(migrated)recordEvent(project,'queue_migrated',`1.2.3：恢复 ${migrated} 个旧版自动提交意图，匹配的已入队草稿清空`);runner=new Runner(()=>({project,folder}),()=>{render().catch(e=>toast(friendlyError(e),true));},toast);
  queuePanel=new QueuePanel(()=>({project,runner}));runner.onActivity=()=>queuePanel.update();runner.beforeNew=async()=>{while(preparing||directoryBusy||assetLibrary?.busy||batchPanel?.busy)await new Promise(r=>setTimeout(r,100));};
  assetLibrary=new AssetLibrary({context:()=>({project,folder}),bind:on,ensureIdle:ensureDraftReady,url:localURL,onChange:async()=>{await render();await renderSelected();if(batchPanel&&$('#batch-input').value.trim())batchPanel.preview();captureDraft();await saveProject(project,folder);},onReference:useReferences,referenceIds:activeReferences,referenceLabel:()=>batchMode?'批量共用素材':'当前分镜',showLibrary:()=>view('assets'),toast});
  assetLibrary.reselectFiles=()=>pickAssets(false);
  batchPanel=new BatchPanel({context:()=>({project:{...project,assets:studioAssets(project)},folder}),bind:on,ensureIdle:ensureDraftReady,planImport,defaults:batchDefaults,showLibrary:()=>view('assets')});
  on('#library-return-studio','click',()=>view('studio'));
  credentials=new CredentialsPanel({transport:runner.transport,bind:on,ensureIdle,onConnectionChange:updateConnection,event,save});
  await credentials.initialize();
  for(const job of project.jobs){if(job.state==='submitting'){job.state=job.attempts.at(-1)?.videoId?'queued':'unknown';job.error='页面在提交时中断，请先核实服务端video_id。';}if(job.state==='checking')job.state='download';}
  const recoveredDownloads=recoverDownloads(project);if(recoveredDownloads)recordEvent(project,'download_recovery_enabled','1.2.2：已生成任务自动恢复原视频下载。');
  let saveIssue;try{await saveProject(project,folder);}catch(e){saveIssue=e;await saveProject(project,null);}guide();await render();await renderSelected();if(newerDiskIssue)toast('目录记录暂未能核验，已停止目录写入。请重新选择原项目目录恢复。'+friendlyError(newerDiskIssue),true);if(saveIssue)toast('浏览器记录已恢复，目录暂未保存。'+friendlyError(saveIssue),true);
  $$('.nav[data-view]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.view)));$$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  on('#settings-button','click',showSettings);on('#connection-status','click',showSettings);on('#help-button','click',()=>view('guide'));on('#go-queue','click',()=>view('queue'));on('#new-from-queue','click',()=>view('studio'));
  const connectFolder=async()=>{
    ensureIdle();const candidate=await chooseFolder();directoryBusy=true;$('#choose-folder').disabled=true;try{const existing=await existingProject(candidate);
    if(existing){
      if(hasUnresolved()&&(existing.id!==project.id||existing.updatedAt<project.updatedAt))throw Error('当前项目还有未解决的远端任务，不能切换到其他或更早的记录。请先恢复原任务。');
      if(!confirm(`目录中已有项目“${existing.name}”，包含 ${existing.jobs.length} 镜。恢复此项目及其媒体文件？取消不会改动目录。`))return;
      const restored=await restoreProjectFiles(existing,candidate);project=restored;ensureStudios(project);await loadStudioDraft();for(const key of [...urls.keys()])clearURL(key);event('project_restored','已核对素材、原始下载、历史版本、末帧及成片');
    }
    const backup=await backupReferences(candidate,(n,total,path)=>{$('#directory-details').hidden=false;$('#directory-details').open=true;$('#directory-location-label').textContent=candidate.name+' /';$('#directory-backup-status').textContent=`检测到已有 references 文件，正在备份并核验 ${n} / ${total}：${path}`;});
    if(backup){$('#directory-backup-status').textContent=`已备份 ${backup.count} 个原文件到 ${candidate.name} / ${backup.path}`;event('references_backed_up',`${backup.count} 个文件 → ${backup.path}`);}else $('#directory-backup-status').textContent='references 为空或尚未创建，无需备份。';
    if(!existing)await mirrorAllFiles(candidate);
    folder=candidate;await put('handles','directory',folder);await save();await renderSelected();toast(existing?'项目和媒体文件已恢复。':'本地文件夹已连接。原路径素材保留，生成文件与优化结果保存到这里。');}finally{directoryBusy=false;$('#choose-folder').disabled=false;}
  };
  on('#choose-folder','click',connectFolder);
  on('#new-project','click',async()=>{ensureIdle();if(hasUnresolved())throw Error('请先解决当前项目的远端任务，再新建项目。');if((project.jobs.length||project.assets.length)&&!folder)throw Error('当前项目尚未落盘，请先连接输出目录保存，再新建项目。');const name=prompt('新制作记录名称（将切换整个任务记录，现有目录和文件保留）','我的视频项目');if(!name?.trim())return;if(project.jobs.length&&!confirm('开始新制作记录？已有项目保留在原目录，请确认已保存。'))return;await save();project=makeProject();project.name=name.trim().slice(0,100);ensureStudios(project);folder=null;await remove('handles','directory');await loadStudioDraft();for(const key of [...urls.keys()])clearURL(key);await save();view('studio');toast('已新建制作记录，请选择新的输出文件夹。');});
  on('#restore-folder','click',async()=>{if(!await permitted(folder,true))throw Error('文件夹未授权。');await save();});
  function switchCreationMode(mode){
    creationMode=typeof mode==='boolean'?(mode?'batch':'single'):mode;batchMode=creationMode==='batch';const batch=batchMode;$('.composer').dataset.createMode=creationMode;
    for(const value of ['single','batch','pavo']){const active=value===creationMode,tab=$('#mode-'+value);tab.classList.toggle('selected',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$('#'+value+'-editor').hidden=!active;$('#'+value+'-editor').disabled=!active;}
    $('#job-form').setAttribute('aria-labelledby','mode-'+creationMode);$('#batch-panel').hidden=!batch;$('#pavo-settings').hidden=true;$('#pavo-settings-toggle').setAttribute('aria-expanded','false');
    $('#validation-output').replaceChildren();$('#auto-assets-feedback').hidden=true;
    $('#mode-heading-note').textContent=batch?'批量编排':creationMode==='pavo'?'PavoAI 创作':'单镜创作';$('#creation-mode-note').innerHTML=batch?'<strong>多段一次生成</strong><span>在下方清单编排多镜，读取引用后整批检查；缺省参数在“批量默认设置”里调整。</span>':'<strong>单段生成</strong><span>填写一段画面与动作，生成一个视频。</span>';
    applyExperience();updateModelUI();updateSubmissionControls().catch(e=>toast(friendlyError(e),true));
  }
  async function loadStudioDraft(){
    playback.pauseAll();clearTimeout(draftTimer);batchPanel.resetSource();assetLibrary.resetFilters();const draft=activeStudio(project).draft;
    for(const id of draftFields){const el=$('#'+id);if(el instanceof HTMLSelectElement)el.value=el.querySelector('option[selected]')?.value||el.options[0].value;else el.value=el.defaultValue;}
    selected=draft?.selected?.filter(id=>project.assets.some(a=>a.id===id))||[];batchSelected=draft?.batchSelected?.filter(id=>project.assets.some(a=>a.id===id))||[];pavoSelected=draft?.pavoSelected?.filter(id=>project.assets.some(a=>a.id===id))||[];
    if(draft)for(const id of draftFields)if(id!=='first-frame'&&id!=='last-frame'&&typeof draft.fields[id]==='string')$('#'+id).value=draft.fields[id];
    if(draft&&!draft.pavoDefaultsVersion&&draft.fields['pavo-aspect']==='Auto'&&draft.fields['pavo-seconds']==='4'){$('#pavo-aspect').value='16:9';$('#pavo-seconds').value='12';}
    $('#continuity').checked=draft?.continuity??false;switchCreationMode(experience==='easy'?'pavo':draft?.creationMode||draft?.batchMode||false);updateMode();updatePavoSettings();await renderSelected();
    if(draft&&$('#generation-mode').value==='keyframe')for(const id of ['first-frame','last-frame'])$('#'+id).value=effectiveAsset(project.assets.find(a=>a.id===draft.fields[id]),project.assets)?.id||'';
    if(!draft){let n=1;while(project.jobs.some(j=>j.id==='S'+String(n).padStart(2,'0')))n++;$('#shot-id').value='S'+String(n).padStart(2,'0');let ep=1;while(project.jobs.some(j=>j.episode==='EP'+String(ep).padStart(2,'0')))ep++;$('#episode').value=$('#batch-episode').value='EP'+String(ep).padStart(2,'0');$('#batch-id-prefix').value=$('#shot-id').value;}
    $('#prompt-count').textContent=$('#prompt').value.length+' 字';await render();await renderAssets();
  }
  const showStudioProjects=()=>{const s=activeStudio(project);$('#studio-project-select').innerHTML=project.studios.map(x=>`<option value="${x.id}">${h(x.name)} · ${project.jobs.filter(j=>j.studioId===x.id).length} 镜</option>`).join('');$('#studio-project-select').value=s.id;$('#studio-project-dialog').showModal();};
  on('#studio-new-project','click',()=>{if(assetLibrary.busy||batchPanel.busy||directoryBusy)throw Error('请等待素材或目录操作完成后再创建项目。');$('#studio-new-name').value='';$('#studio-new-dialog').showModal();$('#studio-new-name').focus();});
  on('#studio-new-form','submit',async e=>{e.preventDefault();captureDraft();createStudio(project,$('#studio-new-name').value);await loadStudioDraft();event('studio_created',activeStudio(project).name+'；沿用全局任务队列与输出目录');await save();$('#studio-new-dialog').close();toast('已创建全新创作项目。已有任务与成片仍显示在任务页。');});
  on('#studio-select-project','click',()=>{if(assetLibrary.busy||batchPanel.busy||directoryBusy)throw Error('请等待素材或目录操作完成后再切换项目。');showStudioProjects();});
  on('#studio-project-apply','click',async()=>{const id=$('#studio-project-select').value;if(!project.studios.some(s=>s.id===id))throw Error('项目已不存在，请重新选择。');captureDraft();project.activeStudioId=id;await loadStudioDraft();event('studio_selected',activeStudio(project).name);await save();$('#studio-project-dialog').close();toast('已切换创作草稿和素材库，任务与成片保持完整。');});
  on('#studio-auto-assets','click',async()=>{const prompt=$('#prompt').value.trim();if(!prompt)throw Error('请先填写提示词，再自动关联素材。');const result=matchPromptAssets(prompt,studioAssets(project),project.assets);const region=$('#auto-assets-feedback');region.hidden=false;if(result.ambiguous.length){region.textContent='同名素材无法唯一确定：'+result.ambiguous.join('、')+'。请在提示词填写具体路径，或从素材库手动选择。';throw Error('同名素材有多个来源，尚未自动关联。');}if(!result.ids.length){region.textContent='未找到相同文件名。请在提示词写入素材完整文件名（含后缀），或先导入当前项目素材库。';return;}await useReferences(result.ids);region.textContent=`已关联 ${result.ids.length} 项同名素材；有优化替代时使用当前版本。请核对下方素材。`;});
  $('#job-form').addEventListener('input',()=>{captureDraft();clearTimeout(draftTimer);draftTimer=setTimeout(()=>saveProject(project,folder).catch(e=>toast(friendlyError(e),true)),500);});
  $('#job-form').addEventListener('change',captureDraft);
  on('#mode-single','click',()=>switchCreationMode(false));on('#mode-batch','click',()=>switchCreationMode(true));
  on('#mode-pavo','click',()=>switchCreationMode('pavo'));
  for(const id of ['#mode-single','#mode-batch','#mode-pavo'])on(id,'click',()=>{captureDraft();return saveProject(project,folder);});
  for(const id of ['#mode-single','#mode-batch','#mode-pavo'])on(id,'keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const modes=['single','batch','pavo'],index=e.key==='Home'?0:e.key==='End'?2:(modes.indexOf(creationMode)+(e.key==='ArrowLeft'?2:1))%3;switchCreationMode(modes[index]);$('#mode-'+creationMode).focus();captureDraft();saveProject(project,folder).catch(e=>toast(friendlyError(e),true));}});
  for(const value of ['easy','expert'])on('#experience-'+value,'click',async()=>{experience=value;if(value==='easy')switchCreationMode('pavo');else applyExperience();await put('state','experience',value);captureDraft();await saveProject(project,folder);});
  on('#pavo-upload','click',()=>pickAssets(true));on('#pavo-library','click',()=>view('assets'));
  on('#pavo-settings-toggle','click',()=>{const open=$('#pavo-settings').hidden;$('#pavo-settings').hidden=!open;$('#pavo-settings-toggle').setAttribute('aria-expanded',String(open));});
  const closePavoSettings=()=>{$('#pavo-settings').hidden=true;$('#pavo-settings-toggle').setAttribute('aria-expanded','false');};
  on('#pavo-settings-close','click',closePavoSettings);
  for(const eventName of ['pointerdown','focusin'])document.addEventListener(eventName,e=>{if(!$('#pavo-settings').hidden&&!e.target.closest('#pavo-settings,#pavo-settings-toggle'))closePavoSettings();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#pavo-settings').hidden){closePavoSettings();$('#pavo-settings-toggle').focus();}});
  $('#pavo-settings').addEventListener('click',e=>{const b=e.target.closest('[data-pavo-aspect],[data-pavo-seconds]');if(!b)return;if(b.dataset.pavoAspect)$('#pavo-aspect').value=b.dataset.pavoAspect;else $('#pavo-seconds').value=b.dataset.pavoSeconds;updatePavoSettings();captureDraft();saveProject(project,folder).catch(e=>toast(friendlyError(e),true));});
  for(const id of ['#video-model','#pavo-model','#pavo-generation-mode'])on(id,'change',async()=>{updateModelUI();await updateSubmissionControls();});
  on('#batch-default-library','click',()=>view('assets'));
  for(const id of ['#batch-seconds','#batch-aspect','#batch-episode','#batch-id-prefix']){on(id,'input',updateBatchDefaultsSummary);on(id,'change',()=>{updateBatchDefaultsSummary();if($('#batch-input').value.trim())batchPanel.preview();});}
  on('#generation-mode','change',updateMode);on('#prompt','input',()=>$('#prompt-count').textContent=$('#prompt').value.length+' 字');
  on('#prompt-example','click',()=>{$('#prompt').value='手绘二维水彩风格。一只背着米色旅行包的小熊走入晨雾中的森林，停在溪水旁侧耳倾听。清晨柔光穿过树叶，镜头从背后缓缓跟随，保持人物脸型、衣服和身体比例一致。一个连续动作，无突然切镜。';$('#prompt-count').textContent=$('#prompt').value.length+' 字';});
  on('#optimize-prompt','click',()=>{const d=defaults();$('#prompt').value=requestPrompt(d,d.assetIds.filter(id=>project.assets.find(a=>a.id===id)?.kind==='image').length);$('#prompt-count').textContent=$('#prompt').value.length+' 字';toast('已补充通用约束。具体剧情、身份和动作仍由你决定。');});
  on('#asset-pick-files','click',()=>pickAssets(true));on('#library-pick-files','click',()=>pickAssets(false));
  on('#asset-files','change',async e=>{await importFiles([...e.target.files]);e.target.value='';});on('#library-files','change',async e=>{await importFiles([...e.target.files],false);e.target.value='';});
  $('#drop-zone').addEventListener('dragover',e=>{e.preventDefault();$('#drop-zone').classList.add('dragging');});$('#drop-zone').addEventListener('dragleave',()=>$('#drop-zone').classList.remove('dragging'));$('#drop-zone').addEventListener('drop',run(async e=>{e.preventDefault();$('#drop-zone').classList.remove('dragging');ensureDraftReady();const files=[],metadata=new Map();for(const item of e.dataTransfer.items){if(item.kind!=='file')continue;const handle=await item.getAsFileSystemHandle?.();if(handle?.kind==='file'){const root=uid(),file=await handle.getFile();await put('handles','source:'+root,handle);files.push(file);metadata.set(file,{storage:'source',sources:[{root,rootName:'拖入的原文件',path:file.name}]});}else{const file=item.getAsFile();if(file)files.push(file);}}if(files.length)await planImport(files,{metadata,reference:true});else await importFiles([...e.dataTransfer.files]);}));
  on('#batch-example','click',()=>{batchPanel.invalidate();$('#batch-input').value='晨雾中的森林，小熊从画面左侧走入，停在小溪旁。手绘水彩风格，柔和晨光。\n---\n小熊蹲下，用手指轻触溪水，水面出现轻微涟漪。镜头缓缓推近。\n---\n小熊站起来望向森林深处的一点暖光，露出好奇的表情。镜头保持稳定。';});
  on('#download-template','click',()=>downloadFile('X-AI_批量分镜模板.json',JSON.stringify({shots:[{id:'A01-01',episode:'A01',mode:'reference',seconds:8,aspect_ratio:'9:16',prompt:'以<Picture 1>作为人物参考，小熊走进森林。',dialogue:'',files:['角色图.png','环境声.wav']},{id:'A01-02',episode:'A01',mode:'reference',seconds:8,aspect_ratio:'9:16',prompt:'从上一镜结束位置继续，小熊停下，抬头看向树冠。',files:['角色图.png'],continuity_from:'A01-01'}]},null,2)));
  on('#job-form','submit',async e=>{e.preventDefault();if(preparing)return;ensureDraftReady();const auto=simplified();
    // Directory permission needs a real user gesture; request it at this entry point.
    if(auto&&!folder){await connectFolder();if(!folder)return;}
    if(auto&&!await permitted(folder,true))throw Error('请授权保存目录后再生成。');
    if(auto&&!runner.transport.key){await showSettings();credentials.feedback('填写自己的密钥或启用默认密钥后，再点击生成视频。','info');return;}
    preparing=true;$('#add-jobs').disabled=$('#pavo-submit').disabled=true;
    try{
    if(auto&&batchMode&&batchPanel.entries.size)await batchPanel.prepare();
    let d=defaults(),specs=(batchMode?await batchPanel.specsForQueue():[d]).map(promptSpec);
    if(batchMode&&$('#continuity').checked)specs=specs.map((s,i)=>({...s,continuityFrom:i?specs[i-1].id:null}));
    if(auto){
      const used=new Set(project.jobs.map(j=>j.id));specs=specs.map(s=>{let id=s.id;if(!id||used.has(id)&&!batchMode){let n=1;while(used.has('S'+String(n).padStart(2,'0')))n++;id='S'+String(n).padStart(2,'0');}used.add(id);return {...s,id,episode:s.episode||'EP01'};});
      specs=specs.map(s=>{const result=matchPromptAssets(s.prompt,studioAssets(project),project.assets);if(result.ambiguous.length)throw Error('同名素材无法唯一关联：'+result.ambiguous.join('、')+'。请填写明确路径。');const ids=[...new Set([...s.assetIds,...result.ids])];return {...s,assetIds:ids,mode:s.mode==='keyframe'?'keyframe':ids.length||s.continuityFrom?'reference':'text'};});
      const needs=specs.flatMap(s=>[...s.assetIds,s.firstFrame,s.lastFrame].filter(Boolean)).map(id=>project.assets.find(a=>a.id===id)).filter(a=>a?.kind==='image'&&a.errors?.length);
      if(needs.length){assetLibrary.planOptimize(needs);await assetLibrary.execute();if(assetLibrary.retry.length||assetLibrary.results.some(r=>r.state==='warning'))throw Error('部分素材尚未处理完成，请查看素材处理结果。');assetLibrary.close();}
      specs=specs.map(s=>({...s,assetIds:s.assetIds.map(id=>effectiveAsset(project.assets.find(a=>a.id===id),project.assets)?.id||id),firstFrame:effectiveAsset(project.assets.find(a=>a.id===s.firstFrame),project.assets)?.id||s.firstFrame,lastFrame:effectiveAsset(project.assets.find(a=>a.id===s.lastFrame),project.assets)?.id||s.lastFrame}));
    }
    if(batchMode&&$('#continuity').checked)specs=specs.map((s,i)=>({...s,continuityFrom:i?specs[i-1].id:null}));
    const jobs=specs.map(s=>newJob({...s,autoSubmit:auto,studioId:project.activeStudioId,studioName:activeStudio(project).name,experience:auto?'easy':'expert',creationMode}));const problems=jobs.map(j=>({id:j.id,...validateJob(j,project.assets,[...project.jobs,...jobs])}));
    $('#validation-output').innerHTML=problems.map(p=>`<div><b>${h(p.id)}</b>${p.errors.length?'<ul>'+p.errors.map(s=>'<li>'+h(s)+'</li>').join('')+'</ul>':'<span class="pass"> ✓ 格式检查通过</span>'}${p.warnings.length?'<ul>'+p.warnings.map(s=>'<li>'+h(s)+'</li>').join('')+'</ul>':''}</div>`).join('');if(problems.some(p=>p.errors.length))throw Error('整批尚未加入，请先处理列出的素材或参数问题。');
    const eventsBefore=project.events.length;project.jobs.push(...jobs);for(const j of jobs)event('input_approved',`素材格式与参数检查通过；请求 ${j.seconds} 秒（${j.durationSource}）；内容尚未审核`,j.id);const intakeEvents=project.events.slice(eventsBefore);
    try{await saveProject(project,folder,{requireDisk:auto});}catch(error){project.jobs=project.jobs.filter(j=>!jobs.includes(j));project.events=project.events.filter(event=>!intakeEvents.includes(event));await saveProject(project,folder).catch(()=>{});throw error;}
    // Clear only after durable queue intake; the immutable Job keeps every input.
    if(creationMode==='pavo'){$('#pavo-prompt').value='';pavoSelected=[];lastPavoQueued=null;lastPavoPrompt='';}
    else if(batchMode){$('#batch-input').value='';batchSelected=[];batchPanel.resetSource();}
    else{$('#prompt').value='';$('#dialogue').value='';$('#seed').value='';$('#first-frame').value='';$('#last-frame').value='';selected=[];$('#prompt-count').textContent='0 字';}
    if(!batchMode){let n=1;while(project.jobs.some(j=>j.id==='S'+String(n).padStart(2,'0')))n++;$('#shot-id').value='S'+String(n).padStart(2,'0');}
    $('#validation-output').replaceChildren();await renderSelected();captureDraft();try{await save();}catch(error){toast('任务已入队；新草稿的目录同步稍后重试：'+friendlyError(error),true);}toast(`${jobs.map(j=>j.id).join('、')} 已进入队列；输入框已准备好下一镜。`);view('queue');
    if(auto){$('#pavo-settings').hidden=true;runner.start({automatic:true,onlyUids:jobs.map(j=>j.uid)}).catch(e=>toast(friendlyError(e),true));}
    }finally{preparing=false;await updateSubmissionControls();}
  });
  on('#queue-filter','change',render);on('#refresh-queue','click',async()=>{queuePanel.updatedAt=Date.now();queuePanel.update();if(directoryBusy||assetLibrary?.busy||batchPanel?.busy){toast('已刷新页面进度；当前本地处理完成后可查询服务端。');return;}try{const result=await runner.refreshStatus();if(!runner.running&&!runner.assembling)await render();toast(result.message);}finally{queuePanel.update();}});on('#start-queue','click',()=>{ensureIdle();return runner.start();});on('#pause-queue','click',async()=>{await runner.setPaused(true);queuePanel.update();toast('将完成当前任务的查询和下载，然后停止提交新任务。');render();});
  on('#export-project','click',()=>downloadFile('project.json',JSON.stringify(redact(project),null,2)));on('#export-notes','click',async()=>{const md=reportMarkdown(project);downloadFile('X-AI_制作过程与结果.md',md,'text/markdown');if(folder&&await permitted(folder))await writeFile(folder,'X-AI_制作过程与结果.md',md);});
  on('#import-project','click',()=>{ensureIdle();if(hasUnresolved())throw Error('当前项目还有未解决的远端任务，请先处理，避免遗失在途编号。');$('#project-import').click();});
  on('#project-import','change',async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;ensureIdle();if(hasUnresolved())throw Error('请先解决原任务。');if(!folder||!await permitted(folder))throw Error('请先选择原项目所在文件夹。');if(f.size>20_000_000)throw Error('项目记录超过20MB。');const record=validateProjectFile(JSON.parse(await f.text()));if(!confirm('从此记录恢复项目？会先核对目录中的全部文件，检查通过才更新工作副本。'))return;const restored=await restoreProjectFiles(record,folder);project=restored;ensureStudios(project);await loadStudioDraft();for(const key of [...urls.keys()])clearURL(key);event('project_restored','已核对全部媒体与历史版本');await save();await renderSelected();toast('项目已恢复；请确认密钥已启用。');});
  for(const id of ['#connection-mode','#api-origin','#request-gap'])on(id,'change',async()=>{ensureIdle();project.settings.connection=$('#connection-mode').value;project.settings.origin=$('#api-origin').value;project.settings.submitGap=Math.max(61,Math.min(3600,Number($('#request-gap').value)||61));$('#request-gap').value=project.settings.submitGap;$('#bridge-settings').hidden=project.settings.connection!=='bridge';await save();});
  on('#bridge-token','input',()=>{runner.transport.bridgeToken=$('#bridge-token').value.trim();});
  on('#edit-form','submit',async e=>{e.preventDefault();const j=lookup(currentEdit);ensureIdle();await runner.redo(j,$('#edit-prompt').value.trim(),$('#edit-dialogue').value.trim(),$('#edit-reason').value.trim(),{seconds:Number($('#edit-seconds').value),aspect:$('#edit-aspect').value,mode:$('#edit-mode').value,assetIds:[...$('#edit-assets').selectedOptions].map(o=>o.value),firstFrame:$('#edit-first').value||null,lastFrame:$('#edit-last').value||null});$('#edit-dialog').close();$('#detail-dialog').close();toast('新版本已保存为待提交，点击开始队列才会创建新任务。');});
  on('#video-import','change',async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;ensureIdle();const j=lookup(importTarget);await runner.acceptFile(j,f);await openDetail(j);});
  document.body.addEventListener('click',run(async e=>{const b=e.target.closest('button');if(!b)return;const d=b.dataset;
    if(d.unselect){if(d.referenceMode==='batch')batchSelected=batchSelected.filter(id=>id!==d.unselect);else if(d.referenceMode==='pavo')pavoSelected=pavoSelected.filter(id=>id!==d.unselect);else selected=selected.filter(id=>id!==d.unselect);await renderSelected();captureDraft();await saveProject(project,folder);}
    if(d.selectAsset)await useReferences([d.selectAsset]);
    if(d.fixImage)assetLibrary.planOptimize([project.assets.find(a=>a.id===d.fixImage)]);
    if(d.trimAudio){if(!folder)throw Error('请先选择输出文件夹。');const a=project.assets.find(a=>a.id===d.trimAudio),input=prompt(`输入开始、结束秒数，例如 0,5。原素材共${a.duration.toFixed(2)}秒。`,'0,'+Math.min(5,a.duration).toFixed(2));if(input===null)return;const [s,t]=input.split(/[,，]/).map(Number);assetLibrary.busy=true;assetLibrary.updateSelection();toast('正在本地裁切声音并保持原格式…');try{await newAsset(await trimAudio(a,s,t));}finally{assetLibrary.busy=false;assetLibrary.updateSelection();}}
    if(d.exportAsset){const a=project.assets.find(a=>a.id===d.exportAsset);downloadFile(a.name,await blob(a.blobKey));}
    if(d.detail)await openDetail(lookup(d.detail));if(d.saveVideo){const j=lookup(d.saveVideo);downloadFile(j.current.path.split('/').at(-1),await blob(j.current.blobKey));}
    if(d.recheck){ensureIdle();const j=lookup(d.recheck);toast('正在重新完整解码并抽帧……');await runner.acceptFile(j,await blob(j.current.blobKey),j.attempts.find(a=>a.number===j.current.number));await openDetail(j);}
    if(d.reviewPass){ensureIdle();const j=lookup(d.reviewPass);if(j.current?.qa?.technical!=='passed')throw Error('先完成技术检查，再进行人工审核。');if(!confirm('确认已完整观看和听审：人物、动作、台词、音色与连续性均符合要求？'))return;j.review='approved';j.state='approved';j.reviewedAt=now();event('human_approved','用户确认已完整观看并听审',j.id);await save();await openDetail(j);}
    if(d.reviewFail){ensureIdle();const j=lookup(d.reviewFail),reason=prompt('请写明不合格原因（例如多出字幕、人物变形、台词错配）：');if(!reason?.trim())return;j.review='rejected';j.state='needs_redo';j.error=reason.trim();event('human_rejected',reason,j.id);await save();await openDetail(j);}
    if(d.resumeJob){ensureIdle();$('#detail-dialog').close();await runner.resumeKnown(lookup(d.resumeJob));}
    if(d.downloadHelp){$('#detail-dialog').close();await showSettings();$('#advanced-mode').open=true;$('#connection-advanced').open=true;$('#connection-advanced').scrollIntoView({block:'nearest'});}
    if(d.retryDownload){ensureIdle();$('#detail-dialog').close();await runner.retryDownload(lookup(d.retryDownload));}
    if(d.manualImport){ensureIdle();importTarget=d.manualImport;$('#video-import').click();}
    if(d.bindId){ensureIdle();const j=lookup(d.bindId),id=prompt('粘贴从服务端查到的 video_id（不是 task_id）。此操作不会创建新任务。');if(!id)return;if(!/^[\w-]{8,200}$/.test(id))throw Error('任务编号格式不正确。');j.attempts.at(-1).videoId=id;j.state='queued';j.error=null;event('video_id_bound','人工绑定video_id='+id,j.id);await save();await openDetail(j);}
    if(d.confirmUncreated){ensureIdle();const j=lookup(d.confirmUncreated),proof=prompt('只有已向服务商核实本次未创建任务时才能继续。请填写核实依据：');if(!proof?.trim())return;j.attempts.at(-1).resolved=true;j.attempts.at(-1).uncreatedEvidence=proof;j.state='pending';j.error=null;event('confirmed_not_created',proof,j.id);await save();await openDetail(j);}
    if(d.editJob){ensureIdle();const j=lookup(d.editJob);currentEdit=j.uid;$('#edit-seconds').value=j.seconds;$('#edit-aspect').value=j.aspect;$('#edit-mode').value=j.mode;$('#edit-assets').innerHTML=project.assets.map(a=>`<option value="${a.id}" ${j.assetIds.includes(a.id)?'selected':''}>${h(a.name)}</option>`).join('');for(const [field,value] of [['edit-first',j.firstFrame],['edit-last',j.lastFrame]]){$('#'+field).innerHTML='<option value="">不设置</option>'+project.assets.filter(a=>a.kind==='image').map(a=>`<option value="${a.id}">${h(a.name)}</option>`).join('');$('#'+field).value=value||'';}$('#edit-prompt').value=j.prompt;$('#edit-dialogue').value=j.dialogue;$('#edit-reason').value=j.error||'';$('#edit-title').textContent=j.id+' · '+(j.attempts.length?'新版本修订':'编辑分镜');$('#edit-dialog').showModal();}
    if(d.reviewPrompt){const j=lookup(d.reviewPrompt);downloadFile(j.id+'_AI复核提示词.md',`# 分镜复核\n\n请结合提供的视频、当前参考图、对白，检查并给出具体时间点和修订建议。不要把技术解码通过当作内容通过。\n\n镜号：${j.id}\n时长：${j.seconds}秒\n画幅：${j.aspect}\n\n## 预期画面\n${j.prompt}\n\n## 指定对白\n${j.dialogue||'无对白'}\n\n## 已知问题\n${j.error||'待人工识别'}\n\n## 检查项\n角色身份、服装、道具、画幅填充、字幕、口型与说话人、试音误用、台词遗漏、重复动作、前后连续性。指出证据，不要凭猜测判失败。\n`,'text/markdown');}
    if(d.history){ensureIdle();const [id,i]=d.history.split(':'),j=lookup(id),a=j.attempts[Number(i)];const url=await localURL(a.blobKey);$('#detail-video')?.setAttribute('src',url);if(a.snapshot&&(a.snapshot.seconds!==j.seconds||a.snapshot.aspect!==j.aspect))throw Error('此历史版本的时长或画幅与当前分镜不同，请先修订当前分镜参数再选择。');if(confirm(`已在预览中载入 V${a.number}。是否将其设为当前剪辑版本？后续镜头与成片不会自动回滚，需重新复核。`)){j.current=JSON.parse(JSON.stringify(a));j.state=a.qa?.technical==='passed'?'ready':'needs_redo';j.review='pending';j.error=a.qa?.fatal?.join('；')||null;event('current_version_changed','设为V'+a.number,j.id);await save();await openDetail(j);}}
    if(d.assemble){ensureIdle();b.disabled=true;try{toast('正在浏览器内拼接，首次加载本地媒体引擎约32MB。');const ep=await runner.assemble(d.assemble,progress=>{b.textContent='拼接 '+Math.min(99,Math.round(progress*100))+'%';});toast(`${ep.id} 已拼接并完整解码，文件已写入本地。`);}finally{await render();}}
    if(d.episodePlay){const ep=project.episodes.filter(p=>p.id===d.episodePlay).at(-1);$('#detail-title').textContent=ep.id+' · 成片 V'+ep.version;$('#detail-body').innerHTML='<video id="episode-video" controls></video><p>'+h(ep.seconds.toFixed(2)+'秒 · '+ep.review)+'</p><a class="button secondary" id="episode-download">下载本集</a>';const url=await localURL(ep.blobKey);$('#episode-video').src=url;$('#episode-download').href=url;$('#episode-download').download=ep.path.split('/').at(-1);$('#detail-dialog').showModal();}
    if(b.id==='more-jobs'){queueLimit+=60;await render();}
  }));
  setInterval(()=>{if(selectedView==='queue')queuePanel.update();},1000);
  window.addEventListener('beforeunload',e=>{if(runner.running||runner.localChecks.size||runner.refreshing||runner.assembling||assetLibrary?.busy||batchPanel?.busy||directoryBusy){e.preventDefault();e.returnValue='';}});
  await loadStudioDraft();captureDraft();await saveProject(project,folder);document.documentElement.dataset.ready='true';runner.pauseNew=!!project.queueControl?.paused;watchdog=new QueueWatchdog(()=>({project,folder,runner,busyReason:preparing?'正在接收新镜':directoryBusy?'正在连接目录':assetLibrary?.busy||batchPanel?.busy?'正在处理素材':''}),()=>queuePanel.update());await watchdog.install();setInterval(()=>updateSubmissionControls().catch(()=>{}),1000);
}
init().catch(e=>toast('初始化失败：'+friendlyError(e),true));
