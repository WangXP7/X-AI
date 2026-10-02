import {inspectBatch,parseBatch,allReferences,referenceParts,resolveSourcePath,findAsset,pathKey} from './batch.js';
import {escapeHTML as h,uid,redact} from './core.js';
import {put,downloadFile} from './storage.js';
import {needsResolution,resolveReferences,verifyResolvedDocuments} from './references.js';
const $=s=>document.querySelector(s);
const pause=()=>new Promise(r=>setTimeout(r,0));
const isList=p=>/\.(csv|tsv|json|txt)$/i.test(p);
const isMedia=p=>/\.(png|jpe?g|webp|bmp|gif|mp3|wav|m4a|aac|ogg|flac)$/i.test(p);

export class BatchPanel{
  constructor({context,bind,ensureIdle,planImport,defaults,showLibrary}){
    Object.assign(this,{context,ensureIdle,planImport,defaults});this.entries=new Map();this.busy=false;this.sourceId=null;this.csvPath='';this.rootName='';this.revision=0;this.resolved=null;
    bind('#batch-open-file','click',()=>$('#batch-file').click());
    bind('#batch-file','change',async e=>{const f=e.target.files[0];e.target.value='';if(f){this.csvPath='';await this.load(f);this.location();}});
    bind('#batch-source-folder','click',()=>this.choose());
    bind('#batch-source-fallback','change',async e=>{const files=[...e.target.files];e.target.value='';if(!files.length)return;await this.scanFiles(files);});
    bind('#batch-source-list','change',()=>this.loadSelected());
    bind('#batch-check','click',()=>this.preview());
    bind('#batch-read-assets','click',()=>this.prepare());
    bind('#batch-export-resolved','click',()=>{if(!this.currentResolution())throw Error('请先成功读取引用。');downloadFile('X-AI_展开后分镜与引用来源.json',JSON.stringify(redact({shots:this.resolved.rows,documents:this.resolved.documents,notices:this.resolved.notices}),null,2));});
    bind('#studio-open-library','click',()=>showLibrary());bind('#batch-open-library','click',()=>showLibrary());
    $('#batch-input').addEventListener('input',()=>{this.invalidate();$('#batch-analysis').hidden=true;});
  }
  invalidate(){this.revision++;this.resolved=null;$('#batch-text-report').hidden=true;$('#batch-export-resolved').hidden=true;}
  resetSource(){this.invalidate();this.entries=new Map();this.sourceId=null;this.csvPath='';this.rootName='';$('#batch-source-selector').hidden=true;$('#batch-loaded-file').textContent='';$('#batch-read-status').textContent='';$('#batch-analysis').hidden=true;this.location();}
  currentResolution(){return this.resolved&&this.resolved.input===$('#batch-input').value&&this.resolved.sourceId===this.sourceId&&this.resolved.csvPath===this.csvPath&&!this.resolved.errors.length;}
  options(){return {sourceId:this.sourceId,csvPath:this.csvPath};}
  specs(){const text=$('#batch-input').value;if(needsResolution(inspectBatch(text))&&!this.currentResolution())throw Error('这份清单包含文本或嵌套引用。请先点“读取引用并展开”，核对结果后再入队。');return parseBatch(text,this.defaults(),this.context().project.assets,{...this.options(),rows:this.currentResolution()?this.resolved.rows:undefined});}
  async specsForQueue(){
    this.ensureIdle();this.busy=true;const revision=this.revision;
    try{if(this.currentResolution())await verifyResolvedDocuments(this.resolved.documents,this.entries);if(revision!==this.revision)throw Error('清单已改变，请重新预览。');return this.specs();}
    catch(e){if(/引用文本已改变/.test(e.message)){this.invalidate();$('#batch-analysis').hidden=false;$('#batch-analysis').textContent=e.message;}throw e;}
    finally{this.busy=false;}
  }
  location(){
    $('#batch-source-location').textContent=this.rootName?`素材读取目录：${this.rootName} /　清单位置：${this.csvPath||'请在下面选择清单，才能定位相对路径'}`:'尚未授权素材目录。已有素材可按文件名或编号匹配；新文件请点“选择清单与素材目录”。';
  }
  async load(file){if(file.size>10_000_000)throw Error('清单超过 10MB，请拆分后导入。');this.invalidate();$('#batch-input').value=await file.text();$('#batch-loaded-file').textContent='已载入：'+file.name;this.preview();}
  async choose(){
    this.ensureIdle();if(!window.showDirectoryPicker){$('#batch-source-fallback').click();return;}
    let root;try{root=await showDirectoryPicker({id:'x-ai-input',mode:'read'});}catch(e){if(e.name==='AbortError')return;throw e;}
    this.invalidate();this.busy=true;$('#batch-source-folder').disabled=true;this.entries=new Map();this.sourceId=uid();this.rootName=root.name;this.csvPath='';
    try{
      const scan=async(dir,base='',depth=0)=>{if(depth>64)throw Error('目录层级超过 64 层，请选择更具体的项目目录。');for await(const [name,handle] of dir.entries()){
        const path=base+name;if(handle.kind==='directory'){if(name==='.git')continue;await scan(handle,path+'/',depth+1);}else{this.entries.set(path,handle);if(this.entries.size>20000)throw Error('目录超过 20000 个文件，请选择只包含本项目的目录。');}
        if(this.entries.size%50===0){$('#batch-source-location').textContent=`正在索引 ${this.rootName} / · 已找到 ${this.entries.size} 个文件（仅目录索引，未校验素材）`;await pause();}
      }};
      await scan(root);await put('handles','source:'+this.sourceId,root);await this.finishScan();
    }catch(e){this.entries.clear();this.sourceId=null;this.rootName='';this.csvPath='';$('#batch-source-selector').hidden=true;this.location();throw e;}
    finally{this.busy=false;$('#batch-source-folder').disabled=false;}
  }
  async scanFiles(files){
    this.ensureIdle();this.invalidate();this.sourceId=uid();this.rootName=files[0].webkitRelativePath.split('/')[0];this.entries=new Map(files.map(f=>[f.webkitRelativePath.split('/').slice(1).join('/'),f]));this.csvPath='';
    if(this.entries.size>20000){this.entries.clear();throw Error('目录超过 20000 个文件，请选择更具体的项目目录。');}await this.finishScan();
  }
  async finishScan(){
    const lists=[...this.entries.keys()].filter(isList).sort((a,b)=>a.localeCompare(b,'zh-CN'));
    $('#batch-source-selector').hidden=false;$('#batch-source-list').innerHTML='<option value="">选择清单在该目录中的位置…</option>'+lists.map(p=>`<option value="${h(p)}">${h(p)}</option>`).join('');this.location();
    if(lists.length===1){$('#batch-source-list').value=lists[0];await this.loadSelected();}
    if(!lists.length)throw Error('目录内没有 CSV / TSV / JSON / TXT 清单。请选择同时包含清单与素材的共同上级目录。');
  }
  async loadSelected(){this.invalidate();this.csvPath=$('#batch-source-list').value;this.location();if(this.csvPath){const entry=this.entries.get(this.csvPath);await this.load(entry instanceof File?entry:await entry.getFile());}}
  preview(){
    const region=$('#batch-analysis');region.hidden=false;
    try{
      const text=$('#batch-input').value,info=inspectBatch(text),specs=this.specs(),assets=this.context().project.assets;
      if(this.currentResolution())info.rows=this.resolved.rows;
      const missing=specs.flatMap(s=>[...s.assetIds,s.firstFrame,s.lastFrame].filter(Boolean).filter(id=>!assets.some(a=>a.id===id)).map(ref=>`${s.id}：${ref}`));
      region.innerHTML=`<strong>${h(info.format)} · ${specs.length} 镜 · ${new Set(allReferences(info).map(r=>r.token)).size} 项明确引用</strong>
        <p>${info.headers.length?'已识别列：'+h(info.recognized.join('、')):'清单未写参数时，使用本模式的批量默认设置。'}${specs.some(s=>s.episodeTitle)?' 中文集名按出现顺序映射 EP01、EP02…，原集名保留在记录中。':''}</p>
        ${info.ignored.length?`<details><summary>${info.ignored.length} 列仅作说明，不会作为生成参数</summary><p>${h(info.ignored.join('、'))}</p><p>历史引用、候选审核说明、5 / 12 秒试音不会自动加入参考。需要使用时请写入 files、参考图或参考声音列。</p></details>`:''}
        <p>${missing.length?`有 ${missing.length} 处引用尚未导入，请读取目录素材或在素材库补齐。`:'明确引用已在素材库找到；入队前还会校验尺寸、时长和每镜组合。'} 字段预览如下，最多展示前 20 镜。</p>
        <div class="batch-preview-scroll"><table><thead><tr><th>镜号 / 分组</th><th>秒数</th><th>参考素材</th><th>提示词</th></tr></thead><tbody>${specs.slice(0,20).map(s=>`<tr><td>${h(s.id)}<br>${h(s.episodeTitle||s.episode)}</td><td>${h(s.seconds)}</td><td>${h([...s.assetIds,s.firstFrame,s.lastFrame].filter(Boolean).map(id=>{const a=assets.find(a=>a.id===id);return a?a.name+' ['+a.path+']':id;}).join('；')||'无')}</td><td>${h(s.prompt.slice(0,150))}${s.prompt.length>150?'…':''}</td></tr>`).join('')}</tbody></table></div>
        ${missing.length?`<details><summary>查看缺失引用</summary><ul>${missing.map(x=>'<li>'+h(x)+'</li>').join('')}</ul></details>`:''}`;
    }catch(e){region.textContent=e.message;region.classList.add('has-error');return false;}
    region.classList.remove('has-error');return true;
  }
  resolutionReport(result){
    const region=$('#batch-text-report');region.hidden=false;
    region.innerHTML=`<strong>${result.errors.length?'引用未完全展开，整批暂不入队':'引用展开完成'} · ${result.documents.length} 个文本文件 · ${result.replacements.length} 处文本替换</strong>
      ${result.errors.length?'<ul class="reference-errors">'+result.errors.map(e=>`<li><b>${h(e.shot)}</b>：${h(e.message)}</li>`).join('')+'</ul>':'<p>以下为实际使用的文本；素材按各引用文件所在目录重新定位。原 CSV 和被引用文件均未改写。</p>'}
      ${result.notices.length?'<ul>'+result.notices.map(n=>'<li>'+h(n)+'</li>').join('') :''}
      ${result.documents.length?'<details><summary>查看读取来源与 SHA-256</summary><ul>'+result.documents.slice(0,50).map(d=>`<li>${h(d.path)} · ${h(d.encoding)} · <code>${d.sha256.slice(0,16)}…</code></li>`).join('')+'</ul></details>':''}
      ${result.replacements.slice(0,20).map(r=>`<details class="reference-replacement"><summary>${h(r.shot)} · ${r.field==='prompt'?'提示词':'对白'} · 查看替换前后</summary><p>原引用</p><pre>${h(r.before)}</pre><p>展开后</p><pre>${h(r.after)}</pre></details>`).join('')}
      <p>预览最多列出 20 处替换、50 个来源；下载展开后的清单可查看所有引用链。入队时会再核对文本文件哈希。</p>`;
    $('#batch-export-resolved').hidden=!!result.errors.length;
  }
  async prepare(){
    this.ensureIdle();let info=inspectBatch($('#batch-input').value);const input=$('#batch-input').value,revision=this.revision;
    if(!this.csvPath||!this.sourceId)throw Error('先选择清单与素材的共同上级目录，再选中该目录内的清单，才能读取相对路径。');
    this.busy=true;$('#batch-read-assets').disabled=true;const files=new Map(),issues=[];
    try{
      if(needsResolution(info)){
        this.resolved=null;$('#batch-export-resolved').hidden=true;$('#batch-text-report').hidden=true;
        const result=await resolveReferences(info,{entries:this.entries,csvPath:this.csvPath,sourceId:this.sourceId,assets:this.context().project.assets,defaultId:this.defaults().id,cancelled:()=>revision!==this.revision||input!==$('#batch-input').value,onProgress:({path,count})=>{$('#batch-read-status').textContent=`递归读取文本 ${count}：${path}`;}});
        if(revision!==this.revision||input!==$('#batch-input').value)return;
        this.resolved={...result,input,sourceId:this.sourceId,csvPath:this.csvPath};this.resolutionReport(result);
        if(result.errors.length){$('#batch-read-status').textContent='请处理引用错误后重新读取；未导入素材，也未改变原清单。';return;}
        info={...info,rows:result.rows};
      }
      const references=allReferences(info);
      if(!references.length){$('#batch-read-status').textContent=this.currentResolution()?'文本已展开，本批没有素材引用。':'清单没有文件引用，可直接预览并检查入队。';this.preview();return;}
      const aliases=new Map();for(const {token} of references){const r=referenceParts(token);if(r.alias){const set=aliases.get(r.alias)||new Set();set.add(r.target);aliases.set(r.alias,set);}}
      let n=0;for(const {token,shot} of references){
        const {alias,target}=referenceParts(token);n++;$('#batch-read-status').textContent=`定位引用 ${n} / ${references.length}：${target}`;if(n%25===0)await pause();
        try{
          let path;
          if(/[\/\\]/.test(target)||isMedia(target))path=resolveSourcePath(this.csvPath,target);
          else{
            const definitions=[...(aliases.get(target)||[])];if(definitions.length>1)throw Error('清单内这个编号指向多个路径，请逐镜填写明确路径。');
            if(definitions.length===1)path=resolveSourcePath(this.csvPath,definitions[0]);
            else{
              const matches=/^[a-z]+\d+[a-z]?$/i.test(target)?[...this.entries.keys()].filter(p=>isMedia(p)&&new RegExp('^'+target+'(?:[_ .-]|$)','i').test(p.split('/').at(-1))):[];
              if(matches.length>1)throw Error('编号对应多个版本，请在清单写明 编号=相对路径。');
              if(matches.length===1)path=matches[0];
              else{const existing=findAsset(target,this.context().project.assets,this.options());if(existing)continue;throw Error('目录和素材库中未找到此编号，请写明相对路径。');}
            }
          }
          if(!this.entries.has(path)){const same=[...this.entries.keys()].filter(p=>pathKey(p).toLowerCase()===path.toLowerCase());if(same.length>1)throw Error('路径有多个仅大小写不同的文件，请写明准确路径。');if(same.length===1)path=same[0];}
          const entry=this.entries.get(path);if(!entry)throw Error('文件不存在，请检查相对路径；不会按同名文件猜测。');if(!isMedia(path))throw Error('引用的文件不是支持的图片或声音。');
          let item=files.get(path);if(!item){item={file:entry instanceof File?entry:await entry.getFile(),extra:{storage:'source',sources:[{root:this.sourceId,rootName:this.rootName,path}],aliases:[]}};files.set(path,item);}
          if(alias)item.extra.aliases.push(alias);if(!isMedia(target)&&!/[\/\\]/.test(target))item.extra.aliases.push(target);
        }catch(e){issues.push(`${shot} · ${token}：${e.message}`);}
      }
      const region=$('#batch-analysis');region.hidden=false;region.innerHTML=`<strong>找到 ${files.size} 个文件 · ${issues.length} 处问题</strong><p>只读取清单明确引用的素材；导入后可再次预览匹配结果。</p>${issues.length?'<ul>'+issues.map(x=>'<li>'+h(x)+'</li>').join(''):'<p>目录定位完成，下一步显示素材校验清单。</p>'}`;
      $('#batch-read-status').textContent=issues.length?'请先修正列出的引用，再重新读取。未开始素材导入。':`定位完成：${files.size} 个文件，重复引用已合并。`;
      if(issues.length)return; // All references must be unambiguous before importing any files.
      if(revision!==this.revision||input!==$('#batch-input').value)throw Error('清单已改变，请重新读取。');
      const list=[...files.values()];this.busy=false;
      if(list.length)await this.planImport(list.map(x=>x.file),{metadata:new Map(list.map(x=>[x.file,x.extra])),reference:false});else this.preview();
    }finally{this.busy=false;$('#batch-read-assets').disabled=false;}
  }
}
