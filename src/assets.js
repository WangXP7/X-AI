import {escapeHTML as h,recordEvent,now,friendlyError,redact} from './core.js';
import {blob,remove,saveProject,writeAssetFile,permitted,downloadFile} from './storage.js';
import {importAsset,optimizeImage} from './media.js';
import {createArchive,archiveNames,ARCHIVE_LIMIT} from './archive.js';

const $=s=>document.querySelector(s);
const mb=n=>(n/1_000_000).toFixed(2)+' MB';
const breathe=()=>new Promise(resolve=>setTimeout(resolve,0));
const importChecks=[
  '文件格式与可读取性：尝试解码图片、读取声音信息。损坏或不支持的文件会单独列出，不中断其余素材。',
  '文件大小：API 参考文件须小于 15MB；超过限制的素材会标记待处理。单文件超过 150MB 时不导入。',
  '图片：核对 PNG / JPEG / WebP 格式、宽高均为 256–5760 像素、宽高比为 0.4–2.5。可修正的问题保留原图并给出优化建议。',
  '声音：读取可播放性和实际时长；本步骤不识别台词。每镜最多 3 段声音，合计 2–12 秒，在加入生成队列时再检查。',
  '重复文件：计算 SHA-256，内容相同的文件复用已有素材；同名但内容不同的文件分别保留。',
  '分镜组合：每镜最多 5 张参考图、3 段声音及素材编号的对应关系，按当前分镜在入队前校验。人物、服装、画面、对白内容仍需人工或外部 AI 审核。'
];

export class AssetLibrary {
  constructor({context,bind,ensureIdle,url,onChange,onReference,referenceIds,referenceLabel=()=> '当前分镜',showLibrary,toast}){
    Object.assign(this,{context,ensureIdle,url,onChange,onReference,referenceIds,referenceLabel,showLibrary,toast});
    this.picked=new Set();this.busy=false;this.renderVersion=0;this.phase='plan';this.mode='import';this.items=[];this.results=[];this.retry=[];
    bind('#assets-select-all','change',()=>{this.picked=new Set($('#assets-select-all').checked?this.context().project.assets.map(a=>a.id):[]);this.updateSelection();});
    bind('#assets-clear-selection','click',()=>{this.picked.clear();this.updateSelection();});
    bind('#assets-select-issues','click',()=>{this.picked=new Set(this.context().project.assets.filter(a=>a.kind==='image'&&a.errors.length).map(a=>a.id));this.updateSelection();});
    bind('#assets-batch-optimize','click',()=>this.planOptimize(this.selected()));
    bind('#assets-batch-download','click',()=>this.download(this.selected()));
    bind('#assets-batch-use','click',()=>this.onReference([...this.picked]));
    bind('#asset-operation-start','click',()=>this.execute());
    bind('#asset-operation-stop','click',()=>this.stop());
    for(const id of ['#asset-operation-close','#asset-operation-done'])bind(id,'click',()=>this.close());
    bind('#asset-operation-resume','click',()=>{this.items=[...this.remaining];this.remaining=[];return this.execute();});
    bind('#asset-operation-retry','click',()=>{this.items=[...this.retry];this.retry=[];return this.execute();});
    bind('#asset-operation-select-results','click',async()=>{this.picked=new Set(this.resultAssets().map(a=>a.id));this.close();this.showLibrary();await this.render();});
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
  updateSelection(){
    const assets=this.context().project.assets,known=new Set(assets.map(a=>a.id));for(const id of this.picked)if(!known.has(id))this.picked.delete(id);
    const count=this.picked.size,all=$('#assets-select-all');all.checked=!!assets.length&&count===assets.length;all.indeterminate=count>0&&count<assets.length;all.disabled=!assets.length||this.busy;
    $('#asset-selection-count').textContent=`已选 ${count} / ${assets.length} 项`;
    for(const id of ['#assets-batch-use','#assets-batch-download','#assets-clear-selection'])$(id).disabled=!count||this.busy;
    $('#assets-batch-optimize').disabled=!this.selected().some(a=>a.kind==='image')||this.busy;
    $('#assets-select-issues').disabled=!assets.some(a=>a.kind==='image'&&a.errors.length)||this.busy;
    for(const input of document.querySelectorAll('[data-pick-asset]')){input.checked=this.picked.has(input.dataset.pickAsset);input.closest('.asset-card').classList.toggle('picked',input.checked);}
  }
  async render(){
    const version=++this.renderVersion,assets=this.context().project.assets,refs=this.referenceIds(),referenceLabel=this.referenceLabel();$('#assets-batch-use').textContent='用于'+referenceLabel;
    $('#asset-library').innerHTML=assets.length?assets.map(a=>`<article class="asset-card ${a.kind==='image'&&a.width/a.height>=2?'asset-wide':''}" data-asset-card="${a.id}">
      <div class="asset-card-selection"><label class="checkbox"><input type="checkbox" data-pick-asset="${a.id}" aria-label="选择 ${h(a.name)}">选择</label><span>${a.derivedFrom?'优化 / 派生版本':'原始素材'}</span></div>
      ${a.kind==='image'?`<button class="asset-thumb" data-preview-asset="${a.id}" aria-label="查看全图 ${h(a.name)}"><img data-library-image="${a.id}" loading="lazy" decoding="async" alt="${h(a.name)}"><span class="asset-preview-hint">查看全图 ↗</span></button>`:'<div class="asset-thumb audio-thumb" aria-label="声音素材">♫</div>'}
      <div class="asset-body"><strong>${h(a.name)}</strong><p>${a.kind==='image'?`${a.width} × ${a.height} · ${(a.width/a.height).toFixed(3)}:1`:a.duration.toFixed(2)+' 秒'} · ${mb(a.bytes)}</p>
      <details class="asset-source"><summary>${a.storage==='source'?'原路径引用 · 不复制文件':a.derivedFrom?'优化版本 · 已另存':'本地工作副本'}${a.effectiveAssetId?' · 已有优化替代':''}</summary><p>位置：${h(a.storage==='source'?(a.sources?.[0]?.rootName||'原素材目录')+' / '+a.path:a.path)}</p>${a.aliases?.length?'<p>编号：'+h(a.aliases.join('、'))+'</p>':''}<p>素材 ID：<code>${h(a.id)}</code></p></details>
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
    if(!files.length)return;this.ensureIdle();this.mode='import';this.items=[...files];this.reference=reference;this.metadata=metadata;
    this.showPlan('导入前校验说明',importChecks,'开始校验并导入');
  }
  planOptimize(assets){
    this.ensureIdle();if(!assets.length)throw Error('请先勾选需要优化的图片。');this.mode='optimize';this.items=[...assets];this.reference=false;
    this.showPlan('批量优化图片',[
      '只优化选中的图片，声音会列为跳过；声音需要你指定裁切的开始与结束时间。',
      '等比缩放、必要时补边，将宽高与比例调整到接口范围。原路径 PNG / JPEG / WebP 保留格式和文件名；其他格式转为 JPEG 并改后缀，不会裁掉人物或伸缩变形。',
      '每张另存并重新校验。清单按路径引用的图片会以同名文件写入 references，自动记录替代关系；原文件不改动。已生成或已提交的任务不回写。',
      '相同原图已有同一优化结果时复用，避免重复生成副本。已合规的优化版会跳过。',
      '优化只修正尺寸与格式，不能恢复模糊细节或校准人物。完成后请查看全图，必要时交给 AI / 图像工具处理。'
    ],'开始优化图片');
  }
  showPlan(title,checks,button){
    this.phase='plan';this.results=[];this.retry=[];this.remaining=[];this.archive=null;this.stopRequested=false;
    $('#asset-operation-title').textContent=title;$('#asset-operation-subtitle').textContent=`已选择 ${this.items.length} 项 · ${mb(this.items.reduce((n,f)=>n+(f.size??f.bytes),0))}`;
    $('#asset-plan-heading').textContent=this.mode==='import'?'本次将在你的电脑上检查':'将执行以下处理';
    $('#asset-check-list').innerHTML=checks.map(text=>`<li>${h(text)}</li>`).join('');
    $('#asset-storage-note').textContent=this.mode==='import'&&this.items.some(f=>this.metadata?.get(f)?.storage==='source')?'原素材直接从清单指定路径读取，不复制到 references；保留浏览器工作缓存，供预览和提交。优化结果才另存到输出目录。':this.context().folder?'结果会写入当前已连接目录，并保留浏览器工作副本。':'尚未连接输出目录：先保存在此浏览器。连接输出目录后写入管理的素材与优化版本；原路径引用不复制。';
    $('#asset-plan-files').innerHTML=this.items.map(f=>`<li>${h(f.name)} <span>${mb(f.size??f.bytes)}</span></li>`).join('');
    $('#asset-operation-start').textContent=button;this.renderOperation();
    if(!$('#asset-operation-dialog').open)$('#asset-operation-dialog').showModal();
  }
  renderOperation(){
    const plan=this.phase==='plan',done=this.phase==='done';
    $('#asset-operation-plan').hidden=!plan;$('#asset-operation-progress').hidden=plan;$('#asset-operation-start').hidden=!plan;
    $('#asset-operation-stop').hidden=!this.busy;$('#asset-operation-stop').disabled=this.stopRequested;
    $('#asset-operation-stop').textContent=this.stopRequested?'将在当前项完成后停止':'完成当前项后停止';
    $('#asset-operation-close').disabled=this.busy;$('#asset-operation-done').hidden=this.busy;$('#asset-operation-done').textContent=plan?'取消':'完成';
    $('#asset-operation-resume').hidden=!done||!this.remaining?.length||this.mode==='download';$('#asset-operation-resume').textContent=`继续剩余 ${this.remaining?.length||0} 项`;
    $('#asset-operation-retry').hidden=!done||!this.retry.length||this.mode==='download';$('#asset-operation-report').hidden=!done;
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
    if(original?.storage==='source'){
      // A same-named file from another source needs its own subdirectory; never
      // overwrite an original already living under references/.
      if(original.path===asset.path||project.assets.some(a=>a.path===asset.path&&a.derivedFrom!==original.id))asset.path='references/'+original.id+'/'+asset.name;
    }
    project.assets.push(asset);recordEvent(project,'asset_'+(this.mode==='import'?'import':'revision'),`${asset.name}；${asset.storage==='source'?'直接引用 '+asset.path:asset.transform||'原始文件'}；SHA-256=${asset.sha256}`);
    await saveProject(project,null); // Keep a recoverable local copy even if the selected disk disconnects.
    if(folder){try{if(!await permitted(folder))throw Error('目录需要重新授权');await writeAssetFile(folder,asset,project);await saveProject(project,folder);}catch(e){this.stopRequested=true;return '素材已保存在浏览器，但写入目录失败：'+friendlyError(e)+'。已停止后续项，请重新授权目录或下载备份。';}}
    await this.activateReplacement(asset);return '';
  }
  async activateReplacement(asset){
    const {project,folder}=this.context(),original=project.assets.find(a=>a.id===asset.derivedFrom);
    if(original?.storage==='source'&&!asset.errors.length&&original.effectiveAssetId!==asset.id){original.effectiveAssetId=asset.id;
      for(const job of project.jobs)if(!job.attempts?.length){job.assetIds=job.assetIds.map(id=>id===original.id?asset.id:id);if(job.firstFrame===original.id)job.firstFrame=asset.id;if(job.lastFrame===original.id)job.lastFrame=asset.id;}
      recordEvent(project,'reference_remapped',`${original.path} → ${asset.path}；仅新任务与尚未提交任务使用优化版`);await saveProject(project,folder);
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
            existing=this.context().project.assets.find(a=>a.sha256===asset.sha256&&!a.derivedFrom);
            if(existing){try{await blob(existing.blobKey);}catch{await remove('blobs',asset.blobKey);throw Error('已有同内容素材，但本地副本缺失。请从原项目目录恢复。');}await remove('blobs',asset.blobKey);}
          }else{
            existing=this.context().project.assets.find(a=>a.derivedFrom===item.id&&['等比缩放、尺寸补边、JPEG转换；原文件保留','等比缩放与补边；保留原路径，优化版同名另存'].includes(a.transform)&&!a.errors.length);
            if(existing){try{await blob(existing.blobKey);}catch{existing=null;}}
            if(!existing)asset=await optimizeImage(item);
          }
          if(existing){
            if(this.mode==='import'&&asset.sources){existing.sources=[...(existing.sources||[]),...asset.sources].filter((s,i,a)=>a.findIndex(x=>x.root===s.root&&x.path===s.path)===i);existing.aliases=[...new Set([...(existing.aliases||[]),...(asset.aliases||[])])];if(existing.storage!=='source'){existing.storage='source';existing.path=asset.path;}await saveProject(this.context().project,this.context().folder);}
            if(this.mode==='optimize'){if(this.context().folder)await writeAssetFile(this.context().folder,existing,this.context().project);await this.activateReplacement(existing);}
            referenceIds.push(existing.id);this.addResult(item,'duplicate',this.mode==='import'?'内容重复，复用已有素材；已记录本次路径与编号。':'已有相同优化结果，复用原优化版本。',existing);continue;}
          const diskIssue=await this.commit(asset);referenceIds.push(asset.id);
          const issues=[...asset.errors,diskIssue].filter(Boolean);this.addResult(item,issues.length?'warning':'success',issues.length?issues.join('；'):this.mode==='import'?'已导入，格式检查通过。':'已另存优化版，格式检查通过。',asset);
        }catch(e){this.retry.push(item);this.addResult(item,'error',friendlyError(e));}
        finally{completed++;this.progress(completed,total,item.name,'处理中');}
      }
      if(this.reference&&referenceIds.length)referenceNotice=await this.onReference([...new Set(referenceIds)],{importing:true});
    }finally{
      this.remaining=this.items.slice(completed);$('#asset-operation-title').textContent=this.stopRequested?'素材处理已停止':this.mode==='import'?'素材导入结果':'图片优化结果';this.busy=false;this.phase='done';this.progress(completed,total,'',this.stopRequested?`已停止 · 剩余 ${total-completed} 项未处理`:'处理结束');this.renderOperation();this.summary();
      if(referenceNotice){$('#asset-operation-feedback').textContent=referenceNotice;$('#asset-operation-feedback').hidden=false;}
      await this.onChange();await this.render();
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
      const entries=[],manifest=[];const names=archiveNames(['X-AI_素材清单.json',...assets.map(a=>a.name)]).slice(1);
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
  exportReport(){
    const rows=this.results.map(r=>`- ${r.name}\n  - 状态：${r.state}；${r.message}\n  - 文件：${r.path||'未产生新文件'}\n  - SHA-256：${r.sha256||'未计算'}`).join('\n');
    downloadFile('X-AI_素材处理记录.md',redact(`# X-AI 素材处理记录\n\n时间：${this.startedAt}\n操作：${this.mode}\n已处理 ${this.results.length} / ${this.items.length} 项\n\n${rows}\n\n格式检查不等于画面或声音内容审核。原素材保留，优化版需查看后再用于分镜。\n`),'text/markdown');
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
