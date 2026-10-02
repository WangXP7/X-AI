import {makeProject,redact,safeName,now,sha256,validateProjectFile} from './core.js';
import {effectiveAsset} from './batch.js';
import {migrateOriginalAssets} from './asset-source.js';
import {durableWrite,pathParts} from './local-write.js';
let database;
export function db(){if(database)return Promise.resolve(database);return new Promise((resolve,reject)=>{const req=indexedDB.open('x-ai-studio',1);req.onupgradeneeded=()=>{for(const n of ['state','blobs','handles'])req.result.createObjectStore(n);};req.onerror=()=>reject(req.error);req.onsuccess=()=>{database=req.result;resolve(database);};});}
async function operation(store,mode,fn){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(store,mode);let result;const r=fn(tx.objectStore(store));r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export const get=(s,k)=>operation(s,'readonly',o=>o.get(k));
export const put=(s,k,v)=>operation(s,'readwrite',o=>o.put(v,k));
export const remove=(s,k)=>operation(s,'readwrite',o=>o.delete(k));
export async function loadProject(){const project=await get('state','project')||makeProject();migrateOriginalAssets(project);return project;}
export async function storeBlob(key,blob){const stable=blob instanceof File?new Blob([await blob.arrayBuffer()],{type:blob.type}):blob;await put('blobs',key,stable);return key;}
export async function blob(key){const b=await get('blobs',key);if(!(b instanceof Blob))throw Error('本地文件未找到，请重新导入文件或从项目目录恢复。');return b;}
export async function getFolder(){return get('handles','directory');}
export async function chooseFolder(){if(!window.showDirectoryPicker)throw Error('自动写入文件需要桌面版 Chrome 或 Edge，请用支持的浏览器打开。');return showDirectoryPicker({id:'x-ai-output',mode:'readwrite'});}
export async function permitted(handle,request=false){if(!handle)return false;let p=await handle.queryPermission({mode:'readwrite'});if(p!=='granted'&&request)p=await handle.requestPermission({mode:'readwrite'});return p==='granted';}
let writing=Promise.resolve();
async function writeDiagnostic(record){try{const records=await get('state','write-diagnostics')||[];records.push(record);await put('state','write-diagnostics',records.slice(-50));}catch{/* Diagnostics must never turn a successful disk commit into a failure. */}}
export function writeFile(handle,path,content){
  const task=async()=>{
    if(!await permitted(handle))throw Error('请先选择本地文件夹并授权写入。');
    return durableWrite(handle,path,content,{diagnostic:writeDiagnostic});
  };
  const result=writing.catch(()=>{}).then(task);writing=result;return result;
}
export async function readFile(handle,path){const parts=pathParts(path);let dir=handle;for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);return (await dir.getFileHandle(parts.at(-1))).getFile();}
export async function backupReferences(directory,onProgress=()=>{}){
  let refs;try{refs=await directory.getDirectoryHandle('references');}catch(e){if(e.name==='NotFoundError')return null;throw e;}
  const files=[];async function list(dir,path=''){for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')await list(entry,path+name+'/');else files.push({path:path+name,entry});}}
  await list(refs);if(!files.length)return null;
  const base='backups/references_'+now().replace(/[:.]/g,'-')+'_'+crypto.randomUUID().slice(0,8),records=[];
  onProgress(0,files.length,base);
  for(const [i,item] of files.entries()){
    const file=await item.entry.getFile(),hash=await sha256(file),dest=base+'/references/'+item.path;
    await writeFile(directory,dest,file);
    if(await sha256(await readFile(directory,dest))!==hash)throw Error('备份校验失败，停止写入：'+item.path);
    records.push({source:'references/'+item.path,backup:dest,sha256:hash});onProgress(i+1,files.length,base);
  }
  await writeFile(directory,base+'/manifest.json',JSON.stringify({at:now(),files:records},null,2));return {path:base,count:files.length};
}
// Only transformed assets are written. Legacy untouched assets are also skipped.
export async function writeAssetFile(directory,asset,project){
  if(!asset.derivedFrom||asset.storage==='source')return;
  const incoming=await blob(asset.blobKey);let previous;
  try{previous=await readFile(directory,asset.path);}catch(e){if(e.name!=='NotFoundError')throw e;}
  if(previous){const hash=await sha256(previous);if(hash===asset.sha256)return;
    const backup='backups/replaced_'+now().replace(/[:.]/g,'-')+'_'+crypto.randomUUID().slice(0,8)+'/'+asset.path;
    await writeFile(directory,backup,previous);if(await sha256(await readFile(directory,backup))!==hash)throw Error('覆盖前备份校验失败，未写入新素材。');
    // Retain the physical path of any older version that this output replaces.
    for(const a of project.assets)if(a.id!==asset.id&&a.storage!=='source'&&a.path===asset.path&&a.sha256===hash)a.path=backup;
  }
  await writeFile(directory,asset.path,incoming);
  if(await sha256(await readFile(directory,asset.path))!==asset.sha256)throw Error('优化文件写入后哈希不一致，请重试保存：'+asset.path);
}
export async function sourceFile(handle,path){return handle.kind==='file'?handle.getFile():readFile(handle,path);}
export async function freshSource(file,extra){
  for(const source of extra.sources||[]){const handle=await get('handles','source:'+source.root);if(handle&&await handle.queryPermission({mode:'read'})==='granted')return sourceFile(handle,source.path);}
  return file;
}
export async function chooseMediaFiles(){
  if(!window.showOpenFilePicker)return null;
  const handles=await showOpenFilePicker({id:'x-ai-media',multiple:true,types:[{description:'参考图片与声音',accept:{'image/*':['.png','.jpg','.jpeg','.webp','.gif','.bmp','.avif'],'audio/*':['.wav','.mp3','.m4a','.ogg','.flac','.aac']}}]});
  const files=[],metadata=new Map();
  for(const handle of handles){const root=crypto.randomUUID(),file=await handle.getFile();await put('handles','source:'+root,handle);files.push(file);metadata.set(file,{storage:'source',sources:[{root,rootName:'原文件',path:file.name}]});}
  return {files,metadata};
}
export async function readAsset(asset){
  if(asset.storage!=='source')return blob(asset.blobKey);
  let hadHandle=false;
  for(const source of asset.sources||[]){const handle=await get('handles','source:'+source.root);if(!handle)continue;hadHandle=true;
    if(await handle.queryPermission({mode:'read'})!=='granted')continue;
    try{const file=await sourceFile(handle,source.path),stable=new Blob([await file.arrayBuffer()],{type:file.type});if(await sha256(stable)!==asset.sha256)throw Error(asset.name+'：原文件已改变，请重新读取清单并校验后再提交。');return stable;}catch(e){if(e.name==='NotFoundError')continue;throw e;}
  }
  if(hadHandle)throw Error(asset.name+'：原素材权限或文件已失效，请重新选择原文件或清单素材目录。');
  // A browser without directory handles supplies user-selected File bytes only.
  return blob(asset.blobKey);
}
let saving=Promise.resolve();
async function unchangedJSON(folder,path,value,field){
  try{const previous=JSON.parse(await(await readFile(folder,path)).text());return JSON.stringify(field?previous?.[field]:previous)===JSON.stringify(field?value[field]:value);}
  catch(error){if(['NotFoundError','InvalidStateError','NotReadableError','SyntaxError'].includes(error.name))return false;throw error;}
}
export function saveProject(project,folder,{requireDisk=false,deferMapping=false}={}){const snapshot=JSON.parse(JSON.stringify(redact(project)));saving=saving.catch(()=>{}).then(async()=>{await put('state','project',snapshot);if(folder&&await permitted(folder)){
  if(!await unchangedJSON(folder,'project.json',snapshot))await writeFile(folder,'project.json',JSON.stringify(snapshot,null,2));
  const mappings=snapshot.assets.filter(a=>a.storage==='source'||a.effectiveAssetId).map(a=>{const effective=effectiveAsset(a,snapshot.assets);return {assetId:a.id,aliases:a.aliases||[],sources:a.sources||[],originalPath:a.path,originalHash:a.sha256,effectiveAssetId:effective.id,effectivePath:effective.path,effectiveStorage:effective.storage||'output',effectiveHash:effective.sha256};});
  const mapping={at:now(),mappings};if((!deferMapping||requireDisk)&&!await unchangedJSON(folder,'reference-mapping.json',mapping,'mappings'))await writeFile(folder,'reference-mapping.json',JSON.stringify(mapping,null,2));
}else if(requireDisk)throw Error('任务尚未提交：请重新授权本地文件夹，确保检查点能落盘。');});return saving;}
export function downloadFile(filename,content,type='application/json'){const data=content instanceof Blob?content:new Blob([content],{type});const url=URL.createObjectURL(data);const a=document.createElement('a');a.href=url;a.download=typeof filename==='string'&&filename.length<=240&&!/[<>:"/\\|?*\x00-\x1f]/.test(filename)?filename:safeName(filename);a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
export function reportMarkdown(p){p=redact(p);return `# X-AI 视频生产记录\n\n导出时间：${now()}\n项目：${p.name}\n\n## 执行约束\n\n单镜4–12秒；每次认证HTTP间隔至少${Math.max(90,p.settings.gap)}秒；单任务串行。已知video_id持续查询，提交不明不得盲重发。原素材、历史尝试和当前成片分别保留。技术通过不代表内容审核通过。\n\n## 分镜结果\n\n|镜号|分组|秒数|状态|当前文件|人工审核|\n|---|---|---:|---|---|---|\n${p.jobs.map(j=>`|${j.id}|${j.episode}|${j.seconds}|${j.state}|${j.current?.path||'尚未生成'}|${j.review||'pending'}|`).join('\n')}\n\n## 逐镜执行与核验\n\n${p.jobs.map(j=>`### ${j.id}\n\n创作项目：${j.studioName||'原有项目'}\n\n提示词：\n\n${j.prompt}\n\n对白：${j.dialogue||'无指定对白'}\n\n原清单引用：${(j.sourceReferences||[]).join('；')||'工作台直接选择'}\n\n文本引用来源（入队快照）：\n\n${(j.textSources||[]).map(s=>`- ${s.field}：${s.chain.join(' → ')}；选取 ${s.selection}；${s.encoding}；SHA-256=${s.sha256}`).join('\n')||'无外部文本引用'}\n\n实际素材：${j.assetIds.map(id=>{const a=p.assets.find(x=>x.id===id);return a?`${id} → ${a.path}`:id;}).join('；')}\n\n${j.attempts.map(a=>`- 尝试 ${a.number}：video_id=${a.videoId||'待核实/未提交'}；${a.path||'未下载'}；SHA-256=${a.sha256||'未计算'}；${a.reason||''}\n  - 核验：${JSON.stringify(a.qa||{})}`).join('\n')}\n\n当前问题：${j.error||'未记录'}\n`).join('\n')}\n## 素材与修订\n\n${p.assets.map(a=>`- ${a.name}；SHA-256=${a.sha256}；${a.path}；${a.storage==='source'?'原路径引用，不复制；编号 '+(a.aliases||[]).join('、'):a.derivedFrom?'派生自 '+a.derivedFrom+'：'+a.transform:'原始文件'}${a.effectiveAssetId?'；运行时替换为 '+(p.assets.find(x=>x.id===a.effectiveAssetId)?.path||a.effectiveAssetId):''}`).join('\n')}\n\n## 事件记录\n\n${p.events.map(e=>`- ${e.at} ${e.jobId||''} [${e.kind}] ${e.message}`).join('\n')}\n\n## 待人工审核\n\n人物身份、口型、台词发音、声音归属、运动连续性、剧情表达及艺术质量需人工或外部AI复核。抽帧与静音检测只是线索，不能自动证明生成合格。\n`;}

// Validate every file before switching the browser's active project.
export async function restoreProjectFiles(record, directory) {
  const project=validateProjectFile(JSON.parse(JSON.stringify(record)));
  migrateOriginalAssets(project);
  const staged=new Map();
  async function stage(key,path,hash){
    if(!key||!path)return;
    const raw=await readFile(directory,path),file=new Blob([await raw.arrayBuffer()],{type:raw.type});
    if(hash&&await sha256(file)!==hash)throw Error(path+'：文件哈希与记录不一致。');
    staged.set(key,file);
  }
  for(const a of project.assets){
    if(a.storage!=='source'){await stage(a.blobKey,a.path,a.sha256);continue;}
    let file;
    for(const source of a.sources||[]){
      const handle=await get('handles','source:'+source.root);if(!handle||await handle.queryPermission({mode:'read'})!=='granted')continue;
      try{const raw=await sourceFile(handle,source.path),candidate=new Blob([await raw.arrayBuffer()],{type:raw.type});if(await sha256(candidate)===a.sha256){file=candidate;break;}}catch{}
    }
    if(!file){try{const cached=await blob(a.blobKey);if(await sha256(cached)===a.sha256)file=cached;}catch{}}
    if(!file)for(const path of a.legacyPaths||[]){try{const raw=await readFile(directory,path),candidate=new Blob([await raw.arrayBuffer()],{type:raw.type});if(await sha256(candidate)===a.sha256){file=candidate;break;}}catch{}}
    if(!file)throw Error(a.name+'：原路径素材暂不可读，请先通过批量清单重新授权原素材目录，再恢复项目。');
    staged.set(a.blobKey,file);
  }
  for(const j of project.jobs){
    const seen=new Set();
    for(const a of [...j.attempts,...(j.current?[j.current]:[])].flatMap(a=>[a,...(a.downloadHistory||[])])){
      const identity=a.blobKey||a.rawBlobKey||String(a.number);if(seen.has(identity))continue;seen.add(identity);
      await stage(a.blobKey,a.path,a.sha256);
      await stage(a.rawBlobKey,a.rawPath,a.rawSha256||a.sha256);
      await stage(a.lastFrameKey,a.lastFramePath,a.lastFrameSha256);
      for(let i=0;i<(a.frameKeys||[]).length;i++)await stage(a.frameKeys[i],`${a.frameDirectory||`checks/${j.id}_v${a.number}`}/frame_${i+1}.jpg`);
    }
    if(j.state==='submitting'){j.state=j.attempts.at(-1)?.videoId?'queued':'unknown';j.error='提交时页面中断，保留记录并核实原任务。';}
    if(j.state==='checking')j.state='download';
  }
  for(const e of project.episodes)await stage(e.blobKey,e.path,e.sha256);
  for(const [key,file] of staged)await storeBlob(key,file);
  return project;
}
export async function existingProject(directory){
  try{return validateProjectFile(JSON.parse(await (await readFile(directory,'project.json')).text()));}
  catch(e){if(e.name==='NotFoundError')return null;throw Error('目录中存在无法读取的project.json。为保护原文件，未写入任何内容。'+e.message);}
}
