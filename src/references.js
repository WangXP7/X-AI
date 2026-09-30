import {parseCSV,fieldKey,pick,setField,batchReferences,referenceList,referenceParts,resolveSourcePath,pathKey,findAsset} from './batch.js';
import {sha256} from './core.js';

export const TEXT_EXTENSIONS=['txt','md','markdown','json','csv','tsv'];
const mediaExt=/\.(png|jpe?g|webp|bmp|gif|avif|mp3|wav|m4a|aac|ogg|flac)$/i;
const textExt=/\.(txt|md|markdown|json|csv|tsv)$/i;
const limits={depth:12,files:500,bytes:10_000_000,fileBytes:2_000_000,fieldChars:12000};
const trim=v=>String(v??'').trim();
function splitRef(value){const s=trim(value),index=s.indexOf('#');return {path:index<0?s:s.slice(0,index),selector:index<0?'':decodeURIComponent(s.slice(index+1))};}
function unquote(s){return trim(s).replace(/^(?:`([^`]+)`|<([^>]+)>|"([^"]+)")$/,'$1$2$3');}
const isFile=v=>/\.(txt|md|markdown|json|csv|tsv|png|jpe?g|webp|bmp|gif|avif|mp3|wav|m4a|aac|ogg|flac|pdf|docx?|xlsx?|html?|ya?ml)(?:#[^\r\n]*)?$/i.test(trim(v))&&!/[\r\n]/.test(v);
function wholeReference(value,explicit=false){
  if(value&&typeof value==='object'&&!Array.isArray(value)){if(typeof value.$ref==='string')return value.$ref;throw Error('引用对象需写成 {"$ref":"相对路径#定位"}。');}
  if(typeof value!=='string')return null;
  const s=unquote(value),marker=s.match(/^@file\(([^)]+)\)$/s)||s.match(/^\{\{(?:file|引用)\s*:\s*([^{}]+)\}\}$/s);
  if(marker)return unquote(marker[1]);
  const named=s.match(/^(?:(?:提示词|对白|台词|内容)\s*)?(?:请)?(?:引用|读取|详见|参见|见|参考|取自)(?:文件)?\s*[:：]?\s*(.+)$/s);
  if(named&&isFile(unquote(named[1])))return unquote(named[1]);
  if(!explicit&&inlineReferences(s).some(r=>r.raw!==s))return null;
  if(!explicit&&inlineReferences(s).some(r=>r.raw===s&&r.target!==s))return null;
  return (explicit||isFile(s))?s:null;
}
// Only explicit file syntax is expanded; ordinary instructions remain text.
function inlineReferences(text){
  const re=/\{\{(?:file|引用)\s*:\s*([^}]+)\}\}|@file\(([^)]+)\)|!?\[([^\]\n]*)\]\((<[^>]+>|[^)\n]+)\)/g;
  const refs=[...text.matchAll(re)].map(m=>({start:m.index,end:m.index+m[0].length,raw:m[0],label:m[3]||'',target:unquote(m[1]||m[2]||m[4].replace(/\s+"[^"]*"\s*$/,''))}));
  const paths=/(?<![\w\/\\])\.{1,2}[\/\\][^\s<>"'|;,，；(){}]+?\.(?:txt|md|markdown|json|csv|tsv|png|jpe?g|webp|mp3|wav|m4a)(?:#[^\s，。；;,)]+)?/gi;
  for(const m of text.matchAll(paths))if(!refs.some(r=>m.index<r.end&&m.index+m[0].length>r.start))refs.push({start:m.index,end:m.index+m[0].length,raw:m[0],label:'',target:m[0]});
  return refs.sort((a,b)=>a.start-b.start);
}
function containsReference(value){
  if(!value)return false;if(typeof value==='object')return true;
  return !!wholeReference(value)||inlineReferences(String(value)).some(r=>!/^https?:/i.test(r.target)||isFile(r.target));
}
function nestedReference(value){const target=referenceParts(value).target;return textExt.test(splitRef(target).path)||inlineReferences(target).some(r=>r.raw!==target||r.target!==r.raw);}
export function needsResolution(info){return info.rows.some(row=>
  pick(row,'promptFile')!==undefined||pick(row,'dialogueFile')!==undefined||containsReference(pick(row,'prompt'))||containsReference(pick(row,'dialogue'))||
  (batchReferences(row)||[]).some(nestedReference)||
  ['first','last'].some(k=>nestedReference(trim(pick(row,k))))
);}

export function locateEntry(entries,path){
  if(entries.has(path))return {path,entry:entries.get(path)};
  const matches=[...entries.keys()].filter(p=>pathKey(p).toLowerCase()===pathKey(path).toLowerCase());
  if(matches.length>1)throw Error('存在仅大小写不同的多个文件，请使用准确路径：'+path);
  if(!matches.length)throw Error('找不到文件：'+path);
  return {path:matches[0],entry:entries.get(matches[0])};
}
function relativePath(fromFile,toFile){
  const a=pathKey(fromFile).split('/').slice(0,-1),b=pathKey(toFile).split('/');let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;
  return [...a.slice(i).map(()=> '..'),...b.slice(i)].join('/')||'./'+b.at(-1);
}
function markdownSection(text,selector,shot){
  const lines=text.split(/\r?\n/),headings=[];let fence=null;
  for(let i=0;i<lines.length;i++){const f=lines[i].match(/^\s*(`{3,}|~{3,})/);if(f){if(!fence)fence=f[1][0];else if(f[1][0]===fence)fence=null;continue;}if(fence)continue;const m=lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);if(m)headings.push({line:i,level:m[1].length,title:m[2]});}
  const key=s=>s.replace(/[*`]/g,'').trim().toLowerCase(),slug=s=>key(s).replace(/[\s]+/g,'-');
  const shotMatch=h=>key(h.title)===shot.toLowerCase()||key(h.title).startsWith(shot.toLowerCase()+' ')||key(h.title).startsWith(shot.toLowerCase()+'：')||key(h.title).startsWith(shot.toLowerCase()+' |');
  const matches=selector?headings.filter(h=>key(h.title)===key(selector)||slug(h.title)===slug(selector)||key(h.title).startsWith(key(selector)+' ')):headings.filter(shotMatch);
  if(matches.length>1)throw Error('文档内有多个同名标题，请使用唯一标题：'+(selector||shot));
  if(!matches.length){if(selector)throw Error('未找到 Markdown 标题：'+selector);if(headings.some(h=>/^[A-Z]+\d+[-_]\d+/i.test(key(h.title))))throw Error('多镜文档中未找到 '+shot+'，请用 #标题 明确指定片段。');return {text,selection:'全文'};}
  const h=matches[0],end=headings.find(x=>x.line>h.line&&x.level<=h.level)?.line??lines.length;
  return {text:lines.slice(h.line+1,end).join('\n').trim(),selection:h.title};
}
function jsonPointer(data,selector){
  if(!selector.startsWith('/')){if(data&&typeof data==='object'&&Object.hasOwn(data,selector))return data[selector];throw Error('JSON 定位请使用 #/字段/子字段，或已有的顶层字段名。');}
  let value=data;for(const part of selector.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))){if(value===null||typeof value!=='object'||!Object.hasOwn(value,part))throw Error('JSON 定位不存在：#'+selector);value=value[part];}return value;
}
function selectShot(value,shot,selector){
  if(selector)return {value:jsonPointer(value,selector),selection:'#'+selector};
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,shot))return {value:value[shot],selection:shot};
  const rows=Array.isArray(value)?value:Array.isArray(value?.shots)?value.shots:null;
  if(!rows)return {value,selection:'全文'};
  if(rows.every(v=>typeof v==='string'))throw Error('文本数组包含多段内容，请用 #/序号 选择需要的片段。');
  const matches=rows.filter(r=>trim(pick(r||{},'id'))===shot);
  if(matches.length===1)return {value:matches[0],selection:'镜号 '+shot};
  if(matches.length>1)throw Error('引用文件的镜号重复：'+shot);
  if(rows.length===1&&!pick(rows[0]||{},'id'))return {value:rows[0],selection:'唯一记录'};
  throw Error('引用文件中未找到镜号 '+shot+'，请检查镜号或使用 #/字段/序号 定位。');
}
function parseReferenceTable(text,path,purpose){
  if(/\.tsv$/i.test(path))return parseCSV(text,'\t');
  if(purpose==='assets'){
    const candidates=[];
    for(const separator of [',','\t',';','|','，','；'])try{
      const rows=parseCSV(text,separator),keys=Object.keys(rows[0]).map(fieldKey);
      if(keys.some(k=>['id','编号','素材编号'].includes(k))&&keys.some(k=>['path','路径','素材路径'].includes(k)))candidates.push(rows);
    }catch{}
    if(candidates.length>1)throw Error('素材表分隔符不明确，请统一分隔符并为含分隔符的字段加双引号。');
    if(candidates.length===1)return candidates[0];
  }
  return parseCSV(text);
}

export async function resolveReferences(info,{entries,csvPath,sourceId,assets=[],defaultId='S01',onProgress=()=>{},cancelled=()=>false}={}){
  if(!entries||!csvPath||!sourceId)throw Error('请先选择共同上级目录和清单位置，再读取文本与素材引用。');
  const rows=[],documents=new Map(),errors=[],replacements=[],notices=new Set();let totalBytes=0,totalChars=0,operations=0;
  const aliases=new Map(),resolvedAliases=new Map();
  for(const row of info.rows)for(const token of batchReferences(row)||[]){const r=referenceParts(token);if(r.alias){const values=aliases.get(r.alias)||new Set();values.add(r.target);aliases.set(r.alias,values);}}
  function check(){if(cancelled())throw Error('清单已改变，已取消旧引用展开，请重新读取。');if(++operations>20000)throw Error('引用展开超过 20000 次，请精简重复嵌套。');}
  async function documentAt(path){
    check();const located=locateEntry(entries,path);if(documents.has(located.path))return documents.get(located.path);
    if(documents.size>=limits.files)throw Error('本次引用超过 500 个文本文件，请分批处理。');
    const f=typeof located.entry.getFile==='function'?await located.entry.getFile():located.entry;
    if(f.size>limits.fileBytes)throw Error('文本文件超过 2MB，请拆分：'+located.path);totalBytes+=f.size;if(totalBytes>limits.bytes)throw Error('引用文本合计超过 10MB，请分批处理。');
    onProgress({path:located.path,count:documents.size+1});const bytes=new Uint8Array(await f.arrayBuffer());let text,encoding='UTF-8';
    try{if(bytes[0]===255&&bytes[1]===254){encoding='UTF-16LE';text=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);}else if(bytes[0]===254&&bytes[1]===255){encoding='UTF-16BE';text=new TextDecoder('utf-16be',{fatal:true}).decode(bytes);}else text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    catch{try{encoding='GB18030';text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);notices.add(located.path+' 按 GB18030 解码，请核对中文内容。');}catch{throw Error('无法解码文本，请另存为 UTF-8：'+located.path);}}
    if(/[\u0000-\u0008\u000e-\u001f]/.test(text))throw Error('引用文件包含非文本字节，请转换为 TXT / Markdown / JSON：'+located.path);
    const doc={path:located.path,text:text.replace(/^\uFEFF/,''),sha256:await sha256(bytes),bytes:f.size,encoding};documents.set(doc.path,doc);return doc;
  }
  for(let i=0;i<info.rows.length;i++){
    check();const original=info.rows[i],row=structuredClone(original),shot=trim(pick(row,'id')||`${defaultId}-${String(i+1).padStart(2,'0')}`),refs=[],markers=[],sources=[],changes=[],captures=[];const priorRefs=batchReferences(row);
    const remember=(doc,field,selection,chain)=>{const record={root:sourceId,path:doc.path,sha256:doc.sha256,encoding:doc.encoding,field,selection,chain};if(!sources.some(s=>s.path===record.path&&s.field===field&&s.selection===selection))sources.push(record);};
    const canonicalMedia=(token,from)=>{
      const r=referenceParts(token),link=inlineReferences(r.target);if(link.length===1&&link[0].raw===r.target)r.target=link[0].target;
      let target=r.target;
      if(!/[\/\\]/.test(target)&&!mediaExt.test(target)){
        const ready=[...(resolvedAliases.get(target)?.values()||[])];if(ready.length>1)throw Error('编号指向多个不同素材，请指定路径：'+target);if(ready.length===1)return {...ready[0],token:target+'='+referenceParts(ready[0].token).target};
        const definitions=[...(aliases.get(target)||[])];if(definitions.length>1)throw Error('编号在清单中指向多个路径：'+target);if(definitions.length===1){target=definitions[0];from=csvPath;}
        else{const existing=findAsset(target,assets,{sourceId,csvPath});if(existing)return {token:r.token,key:'id:'+existing.id,kind:existing.kind};
          const matches=/^[a-z]+\d+[a-z]?$/i.test(target)?[...entries.keys()].filter(p=>mediaExt.test(p)&&new RegExp('^'+target+'(?:[_ .-]|$)','i').test(p.split('/').at(-1))):[];
          if(matches.length===1)return {token:r.token,key:matches[0],kind:/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(matches[0])?'audio':'image'};
          return {token:r.token,key:'unresolved:'+r.token,kind:null};
        }
      }
      const resolved=resolveSourcePath(from,target),path=locateEntry(entries,resolved).path;
      if(!mediaExt.test(path))throw Error('此文件不是支持的图片或声音：'+path);
      const relative=relativePath(csvPath,path);return {token:r.alias?r.alias+'='+relative:relative,key:path,kind:/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(path)?'audio':'image'};
    };
    function addMedia(token,from,label='',marker=false){
      const media=canonicalMedia(token,from);let entry=refs.find(r=>r.key===media.key);if(!entry){entry=media;refs.push(entry);}else if(!referenceParts(entry.token).alias&&referenceParts(media.token).alias)entry.token=media.token;
      const alias=referenceParts(token).alias;if(alias){const known=resolvedAliases.get(alias)||new Map();known.set(entry.key,entry);resolvedAliases.set(alias,known);}
      for(const capture of captures)capture.set(entry.key,entry);
      if(!marker)return '';const key=`\uE000XAI${markers.length}\uE001`;markers.push({key,entry,label});return key;
    }
    async function content(reference,from,field,chain=[],purpose='text'){
      check();const {path:local,selector}=splitRef(reference);let path=resolveSourcePath(from,local);
      path=locateEntry(entries,path).path;
      if(mediaExt.test(path)){if(selector)throw Error('素材文件不接受文本片段定位：'+reference);return addMedia(relativePath(from,path),from,'',purpose==='text');}
      if(!textExt.test(path))throw Error('暂不支持展开此文件，请转成 TXT / Markdown / JSON / CSV：'+path);
      const identity=path+(selector?'#'+selector:'');if(chain.includes(identity))throw Error('循环引用：'+[...chain,identity].join(' → '));if(chain.length>=limits.depth)throw Error('引用超过 12 层：'+[...chain,identity].join(' → '));
      const next=[...chain,identity],doc=await documentAt(path);let value=doc.text,selection=selector||'全文';
      if(/\.json$/i.test(path)){let data;try{data=JSON.parse(doc.text);}catch{throw Error('JSON 内容格式有误：'+path);}const selected=purpose==='assets'&&!selector?{value:data,selection:'素材清单'}:selectShot(data,shot,selector);value=selected.value;selection=selected.selection;}
      else if(/\.(csv|tsv)$/i.test(path)){const data=parseReferenceTable(doc.text,path,purpose);if(purpose==='assets'){value=selector?data.filter(r=>trim(r.id||r['编号']||r['素材编号'])===selector):data;if(!value.length)throw Error('素材表中未找到编号：'+selector);selection=selector||'素材清单';}else{const selected=selectShot(data,selector||shot,'');value=selected.value;selection=selected.selection;}}
      else if(/\.(md|markdown)$/i.test(path)){const selected=markdownSection(doc.text,selector,shot);value=selected.text;selection=selected.selection;}
      else if(selector)throw Error('TXT 不支持标题定位；请分文件或使用 Markdown 标题：'+path);
      remember(doc,field,selection,next);
      if(purpose==='assets'){await assetContent(value,path,field,next);return '';}
      if(value&&typeof value==='object'){
        if(value.$ref)return content(value.$ref,path,field,next);
        const mapped=pick(value,field+'File'),body=pick(value,field,{includeEmpty:true});
        if(mapped===undefined&&body===undefined)throw Error(`${path} 未提供 ${field==='prompt'?'提示词':'对白'} 字段，请使用 #/字段 精确定位。`);
        const material=batchReferences(value);if(material)for(const ref of material)await assetReference(ref,path,field,next);
        if(mapped!==undefined)return expandFiles(mapped,path,field,next);
        value=body;if(value?.$ref)return content(value.$ref,path,field,next);
      }
      if(typeof value!=='string'&&typeof value!=='number')throw Error('引用结果不是文本，请明确指定字段：'+identity);
      return expandText(String(value),path,field,next);
    }
    async function assetReference(token,from,field,chain){
      const links=inlineReferences(trim(token));if(links.length===1&&links[0].raw===trim(token))token=links[0].target;
      const r=referenceParts(token);let whole=wholeReference(r.target)||r.target,alias=r.alias;
      const definitions=[...(aliases.get(whole)||[])];if(!resolvedAliases.has(whole)&&definitions.length===1&&textExt.test(splitRef(definitions[0]).path)){alias=whole;whole=definitions[0];from=csvPath;}
      const captured=new Map();captures.push(captured);
      try{
        if(textExt.test(splitRef(whole).path)){
          await content(whole,from,field,chain,'assets');
          if(alias){if(captured.size!==1)throw Error('一个素材编号须对应一个文件，请用 #/字段 定位：'+alias);const entry=[...captured.values()][0];entry.token=alias+'='+referenceParts(entry.token).target;const known=resolvedAliases.get(alias)||new Map();known.set(entry.key,entry);resolvedAliases.set(alias,known);}
        }else addMedia(r.alias?r.alias+'='+whole:whole,from);
      }finally{captures.pop();}
      return [...captured.values()];
    }
    async function assetContent(value,from,field,chain){
      let items;
      if(Array.isArray(value))items=value;
      else if(value&&typeof value==='object'){
        if(value.$ref){await content(value.$ref,from,field,chain,'assets');return;}
        items=batchReferences(value)||value.assets;
        if(!items&&Object.values(value).every(v=>typeof v==='string'))items=Object.entries(value).map(([k,v])=>k+'='+v);
        if(!Array.isArray(items))throw Error('素材 JSON 需要 files / assets 数组、编号到路径的对象，或 #/字段定位：'+from);
      }else{
        items=String(value).split(/\r?\n/).map(s=>s.replace(/^\s*[-*+]\s+/,'').trim()).filter(s=>s&&!s.startsWith('#')).flatMap(s=>referenceList(s)||[]);
      }
      for(let item of items){if(item&&typeof item==='object'){const path=item.path||item['路径']||item['素材路径'],id=item.id||item['编号']||item['素材编号'];if(item.$ref)item=item.$ref;else if(typeof path==='string')item=(id?id+'=':'')+path;else throw Error('素材记录应包含 path 或 $ref：'+from);}if(typeof item!=='string')throw Error('素材清单含非路径内容：'+from);await assetReference(item,from,field,chain);}
    }
    async function expandFiles(value,from,field,chain){
      if(value&&typeof value==='object'&&!Array.isArray(value))return content(wholeReference(value,true),from,field,chain);
      const list=Array.isArray(value)?value:referenceList(value)||[];const result=[];
      for(const item of list)result.push(await content(wholeReference(item,true),from,field,chain));return result.join('\n\n');
    }
    async function expandText(text,from,field,chain){
      check();const whole=wholeReference(text);let result='';
      if(whole)result=await content(whole,from,field,chain);
      else{
        const matches=inlineReferences(text);let cursor=0;
        for(const match of matches){result+=text.slice(cursor,match.start);cursor=match.end;
          if(/^https?:/i.test(match.target)&&!isFile(match.target)){result+=match.raw;notices.add('外部网页链接不会抓取：'+match.target);continue;}
          const value=await content(match.target,from,field,chain);result+=value.startsWith('\uE000XAI')&&match.label?match.label+'（'+value+'）':value;
          if(result.length>limits.fieldChars)throw Error('展开后的文本超过 12000 字，请用 #标题 或 #/字段 缩小引用范围。');
        }
        result+=text.slice(cursor);
      }
      if(result.length>limits.fieldChars)throw Error('展开后的文本超过 12000 字，请精简或定位到具体段落。');return result;
    }
    try{
      for(const token of priorRefs||[])await assetReference(token,csvPath,'素材',[]);
      for(const field of ['prompt','dialogue']){
        const file=pick(row,field+'File'),before=pick(row,field,{includeEmpty:true});
        if(file===undefined&&before===undefined)continue;
        const after=file!==undefined?await expandFiles(file,csvPath,field,[]):typeof before==='object'?await content(wholeReference(before,true),csvPath,field,[]):await expandText(String(before??''),csvPath,field,[]);
        setField(row,field,after);setField(row,field+'File',undefined);if(file!==undefined||after!==before)changes.push({field,before:typeof(file??before)==='string'?(file??before):JSON.stringify(file??before),after});
      }
      // Keyframe columns can also point to a nested material list, but each must resolve to one image.
      for(const field of ['first','last']){const value=pick(row,field);if(!value)continue;const start=refs.length,result=await assetReference(value,csvPath,field,[]);if(result.length!==1||result[0].kind!=='image')throw Error('首帧 / 尾帧必须明确对应一张图片。');setField(row,field,result[0].token);refs.splice(start);}
      function substitute(text){return markers.reduce((s,m)=>{if(refs.some(r=>!r.kind))throw Error('无法判定部分素材类型，请先明确编号=路径，再插入图片 / 声音占位。');const n=refs.filter(r=>r.kind===m.entry.kind).indexOf(m.entry)+1;if(n<1)throw Error('素材占位没有对应参考。');return s.split(m.key).join(`<${m.entry.kind==='image'?'Picture':'Audio'} ${n}>`);},text);}
      for(const field of ['prompt','dialogue']){const value=pick(row,field,{includeEmpty:true});if(value!==undefined)setField(row,field,substitute(String(value)));}
      for(const change of changes)change.after=substitute(change.after);
      if(refs.length||priorRefs!==null)setField(row,'files',refs.map(r=>r.token));
      row.sourceReferences=priorRefs||[];row.textSources=sources;row.referenceReplacements=changes;
      totalChars+=JSON.stringify(row).length;if(totalChars>limits.bytes)throw Error('展开结果合计超过 10MB，请分批处理。');
      rows.push(row);replacements.push(...changes.map(c=>({...c,shot})));
    }catch(e){errors.push({shot,message:e.message});rows.push(null);}
  }
  return {rows,documents:[...documents.values()].map(({text,...record})=>record),errors,replacements,notices:[...notices]};
}

export async function verifyResolvedDocuments(documents,entries){
  for(const doc of documents){const {entry}=locateEntry(entries,doc.path),file=typeof entry.getFile==='function'?await entry.getFile():entry;if(await sha256(file)!==doc.sha256)throw Error('引用文本已改变，请重新读取并预览：'+doc.path);}
}
