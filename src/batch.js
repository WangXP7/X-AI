// Delimited lists and references are data, never executable instructions.
const norm=v=>String(v??'').trim().normalize('NFC');
export const fieldKey=v=>norm(v).replace(/^\uFEFF/,'').toLowerCase().replace(/[\s_（）()]/g,'');
const fields={
  id:['id','镜号','镜头编号'], episode:['episode','分集','分组','集名'],
  prompt:['AgnesAI实际提示词','prompt','提示词','画面动作','画面与动作','画面描述'],
  promptFile:['prompt_file','prompt_path','prompt_ref','提示词文件','提示词路径','提示词引用','画面引用'],
  dialogueFile:['dialogue_file','dialogue_ref','对白文件','台词文件','对白引用'],
  seconds:['seconds','秒数','时长秒','时长'], aspect:['aspect_ratio','aspect','画面比例','比例'],
  mode:['mode','生成模式','生成方式'], dialogue:['dialogue','对白','指定对白','台词'], seed:['seed','随机种子'],
  files:['assetIds','files','素材','参考素材','参考文件','素材编号','素材路径'],
  images:['images','image_paths','参考图','图片路径','图像路径','当前图像引用','当前图像候选引用'],
  audio:['audio','audio_paths','参考声音','声音路径','音频路径','声音参考'],
  first:['first_frame','首帧'], last:['last_frame','尾帧'], continuity:['continuity_from','衔接镜号']
};
const known=new Set(Object.values(fields).flat().map(fieldKey));
const delimiters=[',','\t',';','|','，','；'];
export const delimiterName=d=>({',':'逗号','\t':'制表符',';':'分号','|':'竖线','，':'中文逗号','；':'中文分号'}[d]||d);

function cells(text,delimiter,firstOnly=false){
  const rows=[];let row=[],cell='',quoted=false,closed=false,line=1,start=1;
  const finish=()=>{row.push(cell);if(row.some(v=>v.trim()))rows.push({values:row,line:start});row=[];cell='';closed=false;start=line+1;};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else{cell+=c;if(c==='\n')line++;}continue;}
    if(c==='"'&&!cell.trim()&&!closed){cell='';quoted=true;continue;}
    if(c===delimiter){row.push(cell);cell='';closed=false;}
    else if(c==='\n'||c==='\r'){finish();if(firstOnly&&rows.length)return rows;if(c==='\r'&&text[i+1]==='\n')i++;line++;start=line;}
    else if(closed){if(!/\s/.test(c))throw Error(`清单第 ${line} 行：引号结束后还有内容，请将整个字段用双引号包住。`);}
    else cell+=c;
  }
  if(quoted)throw Error(`CSV 第 ${start} 行引号未闭合，请检查双引号。`);
  finish();return rows;
}
function detect(text){
  const candidates=delimiters.map(d=>{try{const h=cells(text,d,true)[0]?.values||[];return {d,h,score:h.filter(v=>known.has(fieldKey(v))).length};}catch{return {d,h:[],score:0};}}).filter(x=>x.h.length>1&&x.score>=2).sort((a,b)=>b.score-a.score);
  if(candidates.length>1&&candidates[0].score===candidates[1].score)throw Error('表头的分隔符不明确，请统一为逗号或制表符，并为含分隔符的字段加双引号。');
  return candidates[0]?.d;
}
export function parseCSV(text,delimiter){
  const s=norm(text);delimiter??=detect(s)||',';
  const rows=cells(s,delimiter);if(rows.length<2)throw Error('CSV 需要表头和至少一行内容。');
  const headers=rows.shift().values.map(norm),keys=headers.map(fieldKey);
  if(keys.some(k=>!k)||new Set(keys).size!==keys.length)throw Error('CSV 表头有空列或重名列，请补全或改名。');
  return rows.map(({values,line})=>{if(values.length!==headers.length)throw Error(`CSV 第 ${line} 行有 ${values.length} 列，表头有 ${headers.length} 列。含逗号、换行或分隔符的内容须用双引号包住。`);return Object.fromEntries(headers.map((h,i)=>[h,values[i]]));});
}
export function inspectBatch(text){
  const s=norm(text);if(!s)throw Error('请填写批量分镜。');if(new TextEncoder().encode(s).length>10_000_000)throw Error('清单超过 10MB，请拆成多个清单。');
  let rows,format,headers=[],delimiter;
  if(s.startsWith('[')||s.startsWith('{')){let d;try{d=JSON.parse(s);}catch{throw Error('JSON 格式有误，请检查引号、逗号和括号。');}rows=Array.isArray(d)?d:d.shots;if(!Array.isArray(rows))throw Error('JSON 应为数组，或包含 shots 数组。');format='JSON';}
  else if((delimiter=detect(s))){rows=parseCSV(s,delimiter);format='表格 · '+delimiterName(delimiter);headers=Object.keys(rows[0]);}
  else{rows=s.split(/\r?\n[ \t]*(?:-{2,}|={3,}|\*{3,}|_{3,})[ \t]*\r?\n/).filter(x=>x.trim()).map(prompt=>({prompt}));format='文本';}
  if(!rows.length||rows.length>1000)throw Error('每次导入 1–1000 镜，请拆分过长的清单。');
  rows.forEach((r,i)=>{if(!r||typeof r!=='object'||Array.isArray(r))throw Error(`第 ${i+1} 段格式有误。`);});
  return {rows,format,headers,delimiter,recognized:headers.filter(h=>known.has(fieldKey(h))),ignored:headers.filter(h=>!known.has(fieldKey(h)))};
}
export function pick(row,field,{includeEmpty=false}={}){
  for(const name of fields[field]){const k=Object.keys(row).find(k=>fieldKey(k)===fieldKey(name));if(k!==undefined&&(includeEmpty||norm(row[k])))return row[k];}
}
export function setField(row,field,value){for(const key of Object.keys(row))if(fields[field].some(name=>fieldKey(name)===fieldKey(key)))delete row[key];row[fields[field][0]]=value;}
export function referenceList(value){
  if(value===undefined||value===null)return null;
  if(Array.isArray(value))return value.flatMap(v=>referenceList(v)||[]);
  if(typeof value!=='string')throw Error('素材引用应为文件名、编号、路径或字符串数组。');
  const s=norm(value);if(!s||/^(无|无参考|none|null)$/i.test(s))return [];
  if(s.startsWith('[')&&!/^\[[^\]\n]*\]\(/.test(s)){try{return referenceList(JSON.parse(s));}catch{throw Error('素材数组格式错误，请用双引号包住每个路径。');}}
  return s.split(/[|;；\r\n]+/).map(norm).filter(Boolean);
}
export function referenceParts(value){
  const s=norm(value),m=s.match(/^([^=＝\/\\]+)[=＝](.+)$/s);
  if(m&&norm(m[1]).length>1000)throw Error('素材编号过长，请改为简短编号并保留明确文件路径。');
  return m?{token:s,alias:norm(m[1]),target:norm(m[2])}:{token:s,alias:null,target:s};
}
export const pathKey=v=>norm(v).replace(/\\/g,'/').replace(/^\.\//,'');
export function resolveSourcePath(csvPath,reference){
  const p=pathKey(reference);
  if(!p||/^(?:[a-z]+:|\/)/i.test(p)||/[\x00-\x1f]/.test(p))throw Error('路径须相对清单；绝对路径或网址不能自动读取。');
  const stack=pathKey(csvPath).split('/').slice(0,-1);
  for(const part of p.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!stack.length)throw Error('路径超出授权目录，请选择同时包含清单和素材的更上一级目录。');stack.pop();}else{if(/[:<>"|?*]/.test(part))throw Error('文件路径包含不支持的字符。');stack.push(part);}}
  if(!stack.length)throw Error('路径未指定文件。');if(stack.join('/').length>=1000)throw Error('素材路径过长，请缩短目录层级或文件名。');return stack.join('/');
}
export function findAsset(reference,assets,{sourceId,csvPath}={}){
  const {target}=referenceParts(reference),value=pathKey(target);
  let found=assets.filter(a=>a.id===target);if(found.length===1)return found[0];
  const isPath=/[\/\\]/.test(target);
  if(sourceId&&csvPath&&(isPath||/\.[a-z0-9]{2,5}$/i.test(target))){const path=resolveSourcePath(csvPath,target).toLowerCase();found=assets.filter(a=>a.sources?.some(s=>s.root===sourceId&&pathKey(s.path).toLowerCase()===path));}
  else if(isPath)found=assets.filter(a=>pathKey(a.path)===value||a.sources?.some(s=>s.path===value));
  else{
    found=assets.filter(a=>a.name===target||a.aliases?.includes(target));
    if(!found.length&&/^[a-z]+\d+[a-z]?$/i.test(target))found=assets.filter(a=>new RegExp('^'+target+'(?:[_ .-]|$)','i').test(a.name));
    if(sourceId){const scoped=found.filter(a=>a.sources?.some(s=>s.root===sourceId));if(scoped.length)found=scoped;}
  }
  found=found.filter(a=>!found.some(original=>original.effectiveAssetId===a.id&&a.derivedFrom===original.id));
  if(found.length>1)throw Error(`素材“${target}”对应多个文件，请改用明确的素材 ID 或相对路径。`);
  return found[0]||null;
}
export function batchReferences(row){
  const main=pick(row,'files',{includeEmpty:true});
  if(main!==undefined)return referenceList(main);
  const images=pick(row,'images',{includeEmpty:true}),audio=pick(row,'audio',{includeEmpty:true});
  return images===undefined&&audio===undefined?null:[...(referenceList(images)||[]),...(referenceList(audio)||[])];
}
export function effectiveAsset(asset,assets){return assets.find(a=>a.id===asset?.effectiveAssetId&&!a.errors?.length)||asset;}
export function parseBatch(text,defaults,assets,options={}){
  const info=inspectBatch(text),groups=new Map();if(options.rows)info.rows=options.rows;
  return info.rows.map((r,i)=>{
    const lookup=v=>effectiveAsset(findAsset(v,assets,options),assets)?.id||referenceParts(v).target;
    const refs=batchReferences(r),id=String(pick(r,'id')||`${defaults.id}-${String(i+1).padStart(2,'0')}`);
    const group=norm(pick(r,'episode')||defaults.episode);let episode=group,episodeTitle='';
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(group)){episodeTitle=group;if(!groups.has(group))groups.set(group,'EP'+String(groups.size+1).padStart(2,'0'));episode=groups.get(group);}
    const f=pick(r,'first'),l=pick(r,'last'),explicitMode=pick(r,'mode'),modes={'文字生成':'text','文字':'text','参考':'reference','参考生成':'reference','首尾帧':'keyframe'};
    return {...defaults,id,episode,episodeTitle,prompt:norm(pick(r,'prompt')),seconds:Number(pick(r,'seconds')??defaults.seconds),aspect:pick(r,'aspect')||defaults.aspect,
      mode:modes[explicitMode]||explicitMode||((f||l)?'keyframe':refs!==null?(refs.length?'reference':'text'):defaults.mode),dialogue:pick(r,'dialogue',{includeEmpty:true})??defaults.dialogue??'',
      seed:pick(r,'seed')!==undefined?Number(pick(r,'seed')):defaults.seed,assetIds:refs?[...new Set(refs.map(lookup))]:[...defaults.assetIds],
      firstFrame:f?lookup(f):defaults.firstFrame,lastFrame:l?lookup(l):defaults.lastFrame,continuityFrom:pick(r,'continuity')||null,sourceReferences:r.sourceReferences||refs||[],textSources:r.textSources||[],referenceReplacements:r.referenceReplacements||[]};
  });
}
export function allReferences(info){
  return info.rows.flatMap((r,i)=>[...(batchReferences(r)||[]),...['first','last'].map(k=>pick(r,k)).filter(Boolean)].map(token=>({token,shot:String(pick(r,'id')||i+1)})));
}
