import {escapeHTML as h,recordEvent,now,friendlyError,redact} from './core.js';
import {blob,remove,storeBlob,saveProject,writeAssetFile,permitted,downloadFile,get} from './storage.js';
import {sourceMetadata,mergeAssetSources} from './asset-source.js';
import {importAsset,optimizeImage} from './media.js';
import {createArchive,ARCHIVE_LIMIT} from './archive.js';
import {studioAssets,currentStudioAssets,attachStudioAsset,activeStudio,clearStudioAssets,restoreStudioAssets} from './studio.js';

const $=s=>document.querySelector(s);
const mb=n=>(n/1_000_000).toFixed(2)+' MB';
const breathe=()=>new Promise(resolve=>setTimeout(resolve,0));
const importChecks=[
  '文件格式与可读取性：尝试解码图片、读取声音信息。损坏或不支持的文件会单独列出，不中断其余素材。',
  '文件大小：API 参考文件须小于 15MB；超过限制的素材会标记待处理。单文件超过 150MB 时不导入。',
  '图片：核对 PNG / JPEG / WebP 格式、宽高均为 256–5760 像素、宽高比为 0.4–2.5。可修正的问题保留原图并给出优化建议。',
  '声音：读取可播放性和实际时长；本步骤不识别台词。每镜最多 3 段声音，合计 2–12 秒，在加入生成队列时再检查。',
  '重复文件：计算 SHA-256，同名且内容相同才复用已有素材；文件名不同或内容不同则分别保留，确保优化后仍与各自原文件同名。',
  '分镜组合：每镜最多 5 张参考图、3 段声音及素材编号的对应关系，按当前分镜在入队前校验。人物、服装、画面、对白内容仍需人工或外部 AI 审核。'
];

export class AssetLibrary {
  constructor({context,bind,ensureIdle,url,onChange,onReference,referenceIds,referenceLabel=()=> '当前分镜',showLibrary,toast}){
    Object.assign(this,{context,ensureIdle,url,onChange,onReference,referenceIds,referenceLabel,showLibrary,toast});
    this.picked=new Set();this.busy=false;this.renderVersion=0;this.phase='plan';this.mode='import';this.items=[];this.results=[];this.retry=[];
    bind('#assets-select-all','change',()=>{this.picked=new Set($('#assets-select-all').checked?this.visibleAssets().map(a=>a.id):[]);this.updateSelection();});
    bind('#assets-clear-selection','click',()=>{this.picked.clear();this.updateSelection();});
    bind('#assets-select-issues','click',()=>{this.picked=new Set(this.visibleAssets().filter(a=>a.kind==='image'&&a.errors.length).map(a=>a.id));this.updateSelection();});
    for(const id of ['#assets-version-filter','#assets-kind-filter','#assets-status-filter','#assets-search'])bind(id,id==='#assets-search'?'input':'change',()=>this.render());
    bind('#assets-clear-library','click',async()=>{this.ensureIdle();const {project,folder}=this.context();const count=studioAssets(project).length;if(!count)return;if(!confirm(`清空当前创作项目的 ${count} 项素材？可恢复；本地文件、已有任务与历史版本保留。`))return;clearStudioAssets(project);this.picked.clear();recordEvent(project,'library_cleared',activeStudio(project).name+'；素材移入可恢复记录');await saveProject(project,folder);await this.onChange();await this.render();this.toast('当前项目素材库已清空，可点击“恢复已清空素材”。');});
    bind('#assets-restore-library','click',async()=>{this.ensureIdle();const {project,folder}=this.context();restoreStudioAssets(project);recordEvent(project,'library_restored',activeStudio(project).name);await saveProject(project,folder);await this.onChange();await this.render();});
    bind('#assets-batch-optimize','click',()=>this.planOptimize(this.selected()));
    bind('#assets-batch-download','click',()=>this.download(this.selected()));
    bind('#assets-batch-use','click',()=>this.onReference([...this.picked]));
    bind('#asset-operation-start','click',()=>this.execute());
    bind('#asset-operation-stop','click',()=>this.stop());
    for(const id of ['#asset-operation-close','#asset-operation-done'])bind(id,'click',()=>this.close());
    bind('#asset-operation-resume','click',()=>{this.items=[...this.remaining];this.remaining=[];return this.execute();});
    bind('#asset-operation-retry','click',()=>{this.items=[...this.retry];this.retry=[];return this.execute();});
    bind('#asset-operation-save','click',()=>this.retrySave());
    bind('#asset-operation-reselect','click',()=>{this.close();return this.reselectFiles();});
    bind('#asset-operation-select-results','click',async()=>{this.resetFilters();this.picked=new Set(this.resultAssets().map(a=>a.id));this.close();this.showLibrary();await this.render();});
    bind('#asset-operation-download-results','click',()=>this.download(this.resultAssets()));
    bind('#asset-operation-report','click',()=>this.exportReport());
    bind('#asset-download-ready','click',()=>{if(this.archive)downloadFile(this.archiveName,this.archive);});
    bind('#asset-library','change',e=>{const id=e.target.dataset.pickAsset;if(!id)return;e.target.checked?this.picked.add(id):this.picked.delete(id);this.updateSelection();});
    bind('#asset-library','click',e=>{const id=e.target.closest('[data-preview-asset]')?.dataset.previewAsset;if(id)return this.preview(id);});
    bind('#asset-preview-fit','click',()=>this.zoom('fit'));bind('#asset-preview-original','click',()=>this.zoom(1));
    bind('#asset-preview-more','click',()=>this.zoom(this.previewScale*1.3));bind('#asset-preview-less','click',()=>this.zoom(this.previewScale/1.3));
    $('#asset-operation-dialog').addEventListener('cancel',e=>{if(this.busy){e.preventDefault();this.stop();}});
    $('#asset-operation-dialog').addEventListener('close',()=>{this.items=[];this.retry=[];this.archive=null;});
    $('#asset-preview-dialog').addEventListener('close',()=>{$('#asset-preview-image').removeAttribute('src');});
  }
  resultAssets(){const ids=new Set(this.results.map(r=>r.assetId).filter(Boolean));return this.context().project.assets.filter(a=>ids.has(a.id));}
  selected(){return this.context().project.assets.filter(a=>this.picked.has(a.id));}
  resetFilters(){for(const id of ['#assets-version-filter','#assets-kind-filter','#assets-status-filter'])$(id).value=id==='#assets-version-filter'?'current':'all';$('#assets-search').value='';this.picked.clear();}
  visibleAssets(){const project=this.context().project,version=$('#assets-version-filter').value,kind=$('#assets-kind-filter').value,status=$('#assets-status-filter').value,search=$('#assets-search').value.trim().normalize('NFC').toLowerCase();let assets=version==='current'?currentStudioAssets(project):studioAssets(project);return assets.filter(a=>(version==='original'?!a.derivedFrom:version==='optimized'?!!a.derivedFrom:true)&&(kind==='all'||a.kind===kind)&&(status==='all'||(status==='issues'?a.errors.length:!a.errors.length))&&(!search||[a.name,a.path,...(a.aliases||[])].some(s=>s.normalize('NFC').toLowerCase().includes(search))));}
  updateSelection(){
    const assets=this.visibleAssets(),known=new Set(assets.map(a=>a.id));for(const id of this.picked)if(!known.has(id))this.picked.delete(id);
    const count=this.picked.size,all=$('#assets-select-all');all.checked=!!assets.length&&count===assets.length;all.indeterminate=count>0&&count<assets.length;all.disabled=!assets.length||this.busy;
    $('#asset-selection-count').textContent=`已选 ${count} / ${assets.length} 项`;
    for(const id of ['#assets-batch-use','#assets-batch-download','#assets-clear-selection'])$(id).disabled=!count||this.busy;
    $('#assets-batch-optimize').disabled=!this.selected().some(a=>a.kind==='image')||this.busy;
    $('#assets-select-issues').disabled=!assets.some(a=>a.kind==='image'&&a.errors.length)||this.busy;
    $('#assets-clear-library').disabled=!studioAssets(this.context().project).length||this.busy;$('#assets-restore-library').hidden=!activeStudio(this.context().project).archivedAssetIds.length;$('#assets-restore-library').disabled=this.busy;
    for(const input of document.querySelectorAll('[data-pick-asset]')){input.checked=this.picked.has(input.dataset.pickAsset);input.closest('.asset-card').classList.toggle('picked',input.checked);}
  }
  async render(){
    const version=++this.renderVersion,assets=this.visibleAssets(),refs=this.referenceIds(),referenceLabel=this.referenceLabel();$('#assets-batch-use').textContent='用于'+referenceLabel;$('#library-project-name').textContent=activeStudio(this.context().project).name;
    $('#asset-library').innerHTML=assets.length?assets.map(a=>`<article class="asset-card ${a.kind==='image'&&a.width/a.height>=2?'asset-wide':''}" data-asset-card="${a.id}">
      <div class="asset-card-selection"><label class="checkbox"><input type="checkbox" data-pick-asset="${a.id}" aria-label="选择 ${h(a.name)}">选择</label><span>${a.derivedFrom?'优化 / 派生版本':'原始素材'}</span></div>
      ${a.kind==='image'?`<button class="asset-thumb" data-preview-asset="${a.id}" aria-label="查看全图 ${h(a.name)}"><img data-library-image="${a.id}" loading="lazy" decoding="async" alt="${h(a.name)}"><span class="asset-preview-hint">查看全图 ↗</span></button>`:'<div class="asset-thumb audio-thumb" aria-label="声音素材">♫</div>'}
      <div class="asset-body"><strong>${h(a.name)}</strong><p>${a.kind==='image'?`${a.width} × ${a.height} · ${(a.width/a.height).toFixed(3)}:1`:a.duration.toFixed(2)+' 秒'} · ${mb(a.bytes)}</p>
      <details class="asset-source"><summary>${a.storage==='source'?'原路径引用 · 不复制文件':a.diskPending?'优化版本 · 待保存目录':a.derivedFrom?'优化版本 · 已另存':'本地工作副本'}${a.effectiveAssetId?' · 已有优化替代':''}</summary><p>位置：${h(a.storage==='source'?(a.sources?.[0]?.rootName||'原素材目录')+' / '+a.path:a.path)}</p>${a.diskPending||a.recordPending?'<p>目录保存未完成，浏览器结果保留；请重试目录保存。</p>':''}${a.aliases?.length?'<p>编号 / 旧路径别名：'+h(a.aliases.join('、'))+'</p>':''}<p>素材 ID：<code>${h(a.id)}</code></p></details>
      ${a.errors.length?`<div class="job-error">${h(a.errors.join('；'))}</div>`:'<span class="status ready">格式检查通过</span>'}
      ${a.kind==='audio'?`<audio data-library-audio="${a.id}" controls preload="none"></audio>`:''}
      <div class="job-actions"><button class="button secondary small" data-select-asset="${a.id}">${refs.includes(a.id)?'已用于':'用于'}${h(referenceLabel)}</button>${a.kind==='image'?`<button class="button secondary small" data-fix-image="${a.id}">优化尺寸 / 格式</button>`:`<button class="button secondary small" data-trim-audio="${a.id}">裁切声音</button>`}<button class="button secondary small" data-export-asset="${a.id}">下载</button></div></div></article>`).join(''):'<div class="empty-state">导入本地参考图或声音。选择文件后会先展示校验清单，再开始检查。</div>';
    this.updateSelection();
    // Lazy decoding avoids rendering hundreds of full-resolution bitmaps at once.
    for(const el of document.querySelectorAll('[data-library-image],[data-library-audio]')){
      if(version!==this.renderVersion)return;const a=assets.find(a=>a.id===(el.dataset.libraryImage||el.dataset.libraryAudio));
      try{const url=await this.url(a.blobKey);if(version===this.renderVersion)el.src=url;}catch{el.replaceWith(document.createTextNode('本地副本缺失，请从原项目目录恢复'));}
    }
  }
  planImport(files,{reference=false,metadata=new Map()}={}){
    if(!files.length)return;this.ensureIdle();this.mode='import';this.items=[...files];this.reference=reference;this.metadata=new Map(files.map(file=>[file,sourceMetadata(file,metadata.get(file)||{})]));
    this.showPlan('导入前校验说明',importChecks,'开始校验并导入');
  }
  planOptimize(assets){
    this.ensureIdle();if(!assets.length)throw Error('请先勾选需要优化的图片。');this.mode='optimize';this.items=[...new Map(assets.map(a=>{const original=this.context().project.assets.find(o=>o.id===a.derivedFrom);const input=original&&a.name!==original.name?original:a;return [input.id,input];})).values()];this.reference=false;
    this.showPlan('批量优化图片',[
      '只优化选中的图片，声音会列为跳过；声音需要你指定裁切的开始与结束时间。',
      '等比缩放、必要时补边，不会裁掉人物或伸缩变形。PNG / JPEG / WebP 保留原格式和完整文件名；其他格式需先用图像工具转换并同步清单后缀。',
      '每张以原文件名另存到 references/optimized 的独立版本目录，并重新校验。自动记录替代关系；原文件不改动，已生成或已提交的任务不回写。成功后默认只显示优化版本，原图可用“原始素材”筛选查看。',
      '相同原图已有同一优化结果时复用，避免重复生成副本。已合规的优化版会跳过。',
      '优化只修正尺寸与格式，不能恢复模糊细节或校准人物。完成后请查看全图，必要时交给 AI / 图像工具处理。'
    ],'开始优化图片');
  }
  showPlan(title,checks,button){
    this.phase='plan';this.results=[];this.retry=[];this.remaining=[];this.archive=null;this.stopRequested=false;
    $('#asset-operation-title').textContent=title;$('#asset-operation-subtitle').textContent=`已选择 ${this.items.length} 项 · ${mb(this.items.reduce((n,f)=>n+(f.size??f.bytes),0))}`;
    $('#asset-plan-heading').textContent=this.mode==='import'?'本次将在你的电脑上检查':'将执行以下处理';
    $('#asset-check-list').innerHTML=checks.map(text=>`<li>${h(text)}</li>`).join('');
    $('#asset-storage-note').textContent=this.mode==='import'?'未修改的图片和声音只引用原文件，不复制到 references，也不改名。浏览器保留校验和预览缓存；只有优化或裁切结果才在输出目录同名另存。拖放或兼容导入无法保存原文件权限时，重新打开后可能需要再选择源文件。':this.context().folder?'优化结果同名另存到 references/optimized 的独立版本目录，原件不改动。':'尚未连接输出目录：优化结果先保存在浏览器。连接目录后只写入优化版本，原始素材不复制。';
    $('#asset-plan-files').innerHTML=this.items.map(f=>`<li>${h(f.name)} <span>${mb(f.size??f.bytes)}</span></li>`).join('');
    $('#asset-operation-start').textContent=button;this.renderOperation();
    if(!$('#asset-operation-dialog').open)$('#asset-operation-dialog').showModal();
  }
  renderOperation(){
    const plan=this.phase==='plan',done=this.phase==='done';
    $('#asset-operation-plan').hidden=!plan;$('#asset-operation-progress').hidden=plan;$('#asset-operation-start').hidden=!plan;
    $('#asset-operation-stop').hidden=!this.busy;$('#asset-operation-stop').disabled=this.stopRequested;
    $('#asset-operation-stop').textContent=this.stopRequested?'将在当前项完成后停止':'完成当前项后停止';
    $('#asset-operation-close').disabled=this.busy;$('#asset-operation-done').hidden=this.busy;$('#asset-operation-done').textContent=plan?'取消':'关闭结果';$('#asset-operation-actions-help').hidden=!done||this.mode==='download';
    $('#asset-operation-resume').hidden=!done||!this.remaining?.length||this.mode==='download';$('#asset-operation-resume').textContent=`继续剩余 ${this.remaining?.length||0} 项`;
    $('#asset-operation-retry').hidden=!done||!this.retry.length||this.mode==='download';$('#asset-operation-report').hidden=!done;
    $('#asset-operation-save').hidden=!done||!this.context().project.assets.some(a=>a.diskPending||a.recordPending);$('#asset-operation-save').disabled=this.busy;
    $('#asset-operation-reselect').hidden=!done||this.mode!=='import'||!this.retry.length;
    $('#asset-download-ready').hidden=!done||!this.archive;
    for(const id of ['#asset-operation-select-results','#asset-operation-download-results'])$(id).hidden=!done||this.mode==='download'||!this.resultAssets().length;$('#asset-operation-feedback').hidden=true;
    $('#asset-operation-dialog').setAttribute('aria-busy',String(this.busy));this.updateSelection();
  }
  progress(completed,total,file,phase){
    $('#asset-progress-bar').max=Math.max(1,total);$('#asset-progress-bar').value=completed;
    $('#asset-progress-count').textContent=`${Math.floor(completed)} / ${total}`;$('#asset-progress-file').textContent=file||'';$('#asset-progress-phase').textContent=phase;
  }
  summary(){
    const counts={success:0,warning:0,duplicate:0,skipped:0,error:0};for(const row of this.results)counts[row.state]++;
    $('#asset-progress-summary').textContent=`完成 ${counts.success} · 待处理 ${counts.warning} · 复用 ${counts.duplicate} · 跳过 ${counts.skipped} · 失败 ${counts.error}`;
  }
  addResult(item,state,message,asset){
    this.results.push({name:item.name,state,message,assetId:asset?.id,path:asset?.path,sha256:asset?.sha256});
    const li=document.createElement('li');li.className=state;const title=document.createElement('strong');title.textContent=item.name;const p=document.createElement('span');p.textContent=message;li.append(title,p);$('#asset-operation-results').append(li);this.summary();
    if(['error','warning'].includes(state))$('#asset-results-details').open=true;
  }
  async commit(asset){
    const {project,folder}=this.context(),original=project.assets.find(a=>a.id===asset.derivedFrom);
    if(original){if(asset.name!==original.name)throw Error('优化结果必须与原素材同名，请重新优化。');asset.path='references/optimized/'+original.id+'/'+asset.id+'/'+original.name;}
    attachStudioAsset(project,asset.id);
    project.assets.push(asset);recordEvent(project,'asset_'+(this.mode==='import'?'import':'revision'),`${asset.name}；${asset.storage==='source'?'直接引用 '+asset.path:asset.transform||'原始文件'}；SHA-256=${asset.sha256}`);
    await saveProject(project,null); // Keep a recoverable local copy even if the selected disk disconnects.
    if(folder)return this.persistAsset(asset);
    await this.activateReplacement(asset);return '';
  }
  async persistAsset(asset){
    const {project,folder}=this.context();
    try{if(!await permitted(folder))throw Error('输出目录需要重新授权。');await writeAssetFile(folder,asset,project);await this.activateReplacement(asset,false);for(const a of project.assets)delete a.recordPending;delete asset.diskPending;await saveProject(project,folder,{deferMapping:true});return '';}
    catch(e){asset.diskPending=true;this.stopRequested=true;const message=friendlyError(e);recordEvent(project,'asset_save_pending',asset.name+'；'+message);await saveProject(project,null);return '素材与记录已保存在浏览器，目录保存未完成。'+message+' 点击“重试目录保存”，无需重新导入。';}
  }
  async retrySave(){
    this.ensureIdle();const {project,folder}=this.context();if(!folder)throw Error('请先选择输出目录。');if(!await permitted(folder,true))throw Error('输出目录未授权，请重新连接目录。');
    this.busy=true;this.renderOperation();let issue='';
    try{for(const asset of project.assets.filter(a=>a.diskPending)){issue=await this.persistAsset(asset);if(issue)break;}if(!issue){for(const a of project.assets)delete a.recordPending;await saveProject(project,folder);for(const [i,row] of this.results.entries()){const a=project.assets.find(a=>a.id===row.assetId);if(a&&row.state==='warning'&&row.message.includes('目录保存')&&!a.diskPending){row.state=a.errors.length?'warning':'success';row.message=a.errors.length?a.errors.join('；'):'目录保存已恢复；原素材未复制，映射已保存。';const li=$('#asset-operation-results').children[i];li.className=row.state;li.querySelector('span').textContent=row.message;}}this.summary();if(!this.remaining.length){this.stopRequested=false;$('#asset-operation-title').textContent=this.mode==='import'?'素材导入结果':'图片优化结果';}this.progress(this.results.length,this.items.length,'','目录保存已恢复'+(this.remaining.length?' · 可继续剩余项':''));}}
    catch(e){issue=friendlyError(e);for(const a of this.resultAssets())a.recordPending=true;await saveProject(project,null);}
    finally{try{$('#asset-operation-feedback').textContent=issue||'目录保存已恢复。原素材未复制，优化文件与引用映射已核验。';$('#asset-operation-feedback').hidden=false;await this.notifyChange();await this.render();}
      finally{this.busy=false;const feedback=$('#asset-operation-feedback'),message=feedback.textContent;this.renderOperation();feedback.textContent=message;feedback.hidden=false;}}
  }
  async notifyChange(){try{await this.onChange();}catch(e){this.stopRequested=true;for(const a of this.resultAssets())a.recordPending=true;await saveProject(this.context().project,null);this.renderOperation();$('#asset-operation-title').textContent='素材已处理 · 目录保存待重试';$('#asset-progress-phase').textContent='本轮素材已保留，请重试目录保存';$('#asset-operation-feedback').textContent='素材校验结果已保存在浏览器，目录记录保存未完成。'+friendlyError(e)+' 点击“重试目录保存”。';$('#asset-operation-feedback').hidden=false;}}
  async activateReplacement(asset,disk=true){
    const {project,folder}=this.context(),original=project.assets.find(a=>a.id===asset.derivedFrom);
    if(original&&!asset.errors.length&&original.effectiveAssetId!==asset.id){const previous=original.effectiveAssetId;original.effectiveAssetId=asset.id;
      for(const studio of project.studios)if(studio.assetIds.includes(original.id)||studio.assetIds.includes(previous)){if(!studio.assetIds.includes(asset.id))studio.assetIds.push(asset.id);}
      for(const job of project.jobs)if(!job.attempts?.length){job.assetIds=job.assetIds.map(id=>id===original.id||(previous&&id===previous)?asset.id:id);if(job.firstFrame===original.id||(previous&&job.firstFrame===previous))job.firstFrame=asset.id;if(job.lastFrame===original.id||(previous&&job.lastFrame===previous))job.lastFrame=asset.id;}
      recordEvent(project,'reference_remapped',`${original.path} → ${asset.path}；仅新任务与尚未提交任务使用优化版`);await saveProject(project,disk?folder:null);
    }
  }
  async execute(){
    this.ensureIdle();this.busy=true;this.phase='running';this.stopRequested=false;this.remaining=[];this.results=[];this.retry=[];this.startedAt=now();this.archive=null;
    const total=this.items.length,referenceIds=[];let referenceNotice='';
    $('#asset-operation-title').textContent=this.mode==='import'?'正在校验并导入素材':'正在优化图片';
    $('#asset-operation-subtitle').textContent=`本轮 ${total} 项 · ${mb(this.items.reduce((n,f)=>n+(f.size??f.bytes),0))}`;$('#asset-operation-results').replaceChildren();$('#asset-results-details').open=false;this.renderOperation();this.summary();
    let completed=0;
    try{
      for(const item of this.items){
        if(this.stopRequested)break;
        this.progress(completed,total,item.name,this.mode==='import'?'校验素材':'优化图片');await breathe();
        try{
          if(this.mode==='optimize'&&item.kind!=='image'){this.addResult(item,'skipped','声音未自动裁切，请单独指定裁切范围。');continue;}
          if(this.mode==='optimize'&&item.derivedFrom&&!item.errors.length){this.addResult(item,'skipped','此派生版本已通过格式检查，无需重复优化。',item);continue;}
          let asset,existing;
          if(this.mode==='import'){
            asset=await importAsset(item,this.metadata?.get(item)||{},phase=>this.progress(completed,total,item.name,phase));
            existing=this.context().project.assets.find(a=>a.sha256===asset.sha256&&a.name===asset.name&&!a.derivedFrom);
            if(existing){try{await blob(existing.blobKey);}catch{await storeBlob(existing.blobKey,await blob(asset.blobKey));}await remove('blobs',asset.blobKey);}
          }else{
            existing=this.context().project.assets.find(a=>a.derivedFrom===item.id&&a.name===item.name&&a.transform==='等比缩放与补边；保留格式与文件名，原文件保留'&&!a.errors.length);
            if(existing){try{await blob(existing.blobKey);}catch{existing=null;}}
            if(!existing)asset=await optimizeImage(item);
          }
          if(existing){
            attachStudioAsset(this.context().project,existing.id);
            if(this.mode==='import')mergeAssetSources(existing,asset);
            await saveProject(this.context().project,null);const diskIssue=this.context().folder?await this.persistAsset(existing):'';
            if(this.mode==='optimize'&&!this.context().folder)await this.activateReplacement(existing);
            referenceIds.push(existing.id);this.addResult(item,diskIssue?'warning':'duplicate',diskIssue||(this.mode==='import'?'内容重复，复用已有素材；原路径与编号已关联，未复制文件。':'已有相同优化结果，复用原优化版本。'),existing);continue;}
          const diskIssue=await this.commit(asset);referenceIds.push(asset.id);
          const issues=[...asset.errors,diskIssue].filter(Boolean);this.addResult(item,issues.length?'warning':'success',issues.length?issues.join('；'):this.mode==='import'?'原文件已关联，格式检查通过；未复制或改名。':'已同名另存优化版，格式检查通过。',asset);
        }catch(e){this.retry.push(item);this.addResult(item,'error',friendlyError(e));}
        finally{completed++;this.progress(completed,total,item.name,'处理中');}
      }
      if(this.reference&&referenceIds.length)referenceNotice=await this.onReference([...new Set(referenceIds)],{importing:true});
    }finally{
      this.remaining=this.items.slice(completed);$('#asset-operation-title').textContent=this.stopRequested?'素材处理已停止':this.mode==='import'?'素材导入结果':'图片优化结果';this.phase='done';this.progress(completed,total,'',this.stopRequested?`已停止 · 剩余 ${total-completed} 项未处理`:'保存本轮引用映射');this.renderOperation();this.summary();
      if(referenceNotice){$('#asset-operation-feedback').textContent=referenceNotice;$('#asset-operation-feedback').hidden=false;}
      try{if(this.mode==='optimize')$('#assets-version-filter').value='current';await this.notifyChange();await this.render();}
      finally{this.busy=false;const feedback=$('#asset-operation-feedback'),message=feedback.hidden?'':feedback.textContent;this.renderOperation();if(message){feedback.textContent=message;feedback.hidden=false;}if(!this.stopRequested)this.progress(completed,total,'','处理结束');}
    }
  }
  stop(){this.stopRequested=true;this.renderOperation();}
  close(){if(this.busy){this.stop();return;}$('#asset-operation-dialog').close();}
  async download(assets){
    this.ensureIdle();if(!assets.length)throw Error('请先勾选要下载的素材。');
    if(assets.reduce((n,a)=>n+a.bytes,0)>ARCHIVE_LIMIT)throw Error('单个 ZIP 最多 500MB，请减少勾选数量，分批下载。');
    this.mode='download';this.items=assets;this.phase='running';this.busy=true;this.stopRequested=false;this.results=[];this.retry=[];this.archive=null;this.startedAt=now();
    $('#asset-operation-title').textContent='批量下载素材';$('#asset-operation-subtitle').textContent=`${assets.length} 项 · 打包为一个 ZIP，保留文件原字节`;
    $('#asset-operation-results').replaceChildren();$('#asset-results-details').open=false;this.renderOperation();this.summary();if(!$('#asset-operation-dialog').open)$('#asset-operation-dialog').showModal();
    try{
      const entries=[],manifest=[];const names=assets.map(a=>'assets/'+a.id+'/'+a.name);
      for(let i=0;i<assets.length;i++){
        if(this.stopRequested)break;const a=assets[i];this.progress(i,assets.length,a.name,'读取本地文件');await breathe();
        try{entries.push({name:names[i],blob:await blob(a.blobKey)});manifest.push({id:a.id,name:a.name,archiveName:names[i],sha256:a.sha256,derivedFrom:a.derivedFrom||null,errors:a.errors});this.addResult(a,'success','已读入 ZIP，原字节保持不变。',a);}
        catch(e){this.addResult(a,'error',friendlyError(e));}
      }
      if(this.stopRequested)throw new DOMException('已停止打包，未发起下载。','AbortError');
      if(!entries.length)throw Error('所选素材的本地副本均不可读取，请从项目目录恢复。');
      entries.push({name:'X-AI_素材清单.json',blob:new Blob([JSON.stringify({createdAt:now(),assets:manifest,results:this.results},null,2)],{type:'application/json'})});
      this.archive=await createArchive(entries,{cancelled:()=>this.stopRequested,onProgress:(n,total,bytes,size)=>this.progress(n+(size?bytes/size:0),total,entries[Math.min(n,total-1)]?.name,'校验 ZIP 并打包')});
      this.archiveName='X-AI_素材_'+new Date().toISOString().replace(/[:.]/g,'-')+'.zip';downloadFile(this.archiveName,this.archive);
      this.progress(entries.length,entries.length,'','ZIP 已准备好，已请求浏览器下载');
    }catch(e){this.progress(this.results.length,assets.length,'',friendlyError(e));}
    finally{this.busy=false;this.phase='done';this.renderOperation();this.summary();}
  }
  async exportReport(){
    const rows=this.results.map(r=>`- ${r.name}\n  - 状态：${r.state}；${r.message}\n  - 文件：${r.path||'未产生新文件'}\n  - SHA-256：${r.sha256||'未计算'}`).join('\n');
    const diagnostics=(await get('state','write-diagnostics')||[]).filter(r=>r.at>=this.startedAt).map(r=>`- ${r.at}；${r.path}；阶段 ${r.stage}；${r.code||'已核对'}；尝试 ${r.attempts}；${r.outcome}`).join('\n');
    downloadFile('X-AI_素材处理记录.md',redact(`# X-AI 素材处理记录\n\n版本：1.1.4\n时间：${this.startedAt}\n操作：${this.mode}\n已处理 ${this.results.length} / ${this.items.length} 项\n\n${rows}\n\n## 本轮目录写入诊断\n\n${diagnostics||'无目录写入异常。'}\n\n格式检查不等于画面或声音内容审核。原素材保留，优化版需查看后再用于分镜。\n`),'text/markdown');
  }
  async preview(id){
    const a=this.context().project.assets.find(a=>a.id===id);if(!a||a.kind!=='image')return;
    this.previewAsset=a;$('#asset-preview-title').textContent=a.name;$('#asset-preview-info').textContent=`${a.width} × ${a.height} · ${mb(a.bytes)} · 等比显示，可放大后滚动查看`;
    const image=$('#asset-preview-image');image.src=await this.url(a.blobKey);image.alt=a.name;if(!$('#asset-preview-dialog').open)$('#asset-preview-dialog').showModal();this.zoom('fit');
  }
  zoom(value){
    const a=this.previewAsset;if(!a)return;const stage=$('#asset-preview-stage');
    this.previewScale=value==='fit'?Math.min(1,(stage.clientWidth-24)/a.width,(stage.clientHeight-24)/a.height):Math.max(.02,Math.min(4,value));
    const image=$('#asset-preview-image');image.style.width=Math.max(1,a.width*this.previewScale)+'px';image.style.height=Math.max(1,a.height*this.previewScale)+'px';
    $('#asset-preview-scale').textContent=Math.round(this.previewScale*100)+'%';stage.scrollTo(0,0);
  }
}
