// A writable stream commits on close. Reopen the destination after a transient
// failure; never reuse a failed stream, a disk-backed File, or a cached handle.
import {sha256} from './core.js';
const TRANSIENT=new Set(['InvalidStateError','NotReadableError','NoModificationAllowedError','AbortError']);
export const WRITE_BACKOFF=[150,450,1000,2000];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function pathParts(path){
  if(typeof path!=='string')throw Error('文件路径不安全。');
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f]/.test(p)))throw Error('文件路径不安全。');
  return parts;
}
async function destination(directory,parts,create){
  let dir=directory;for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create});
  return dir.getFileHandle(parts.at(-1),{create});
}
export async function durableWrite(directory,path,content,{wait=pause,backoff=WRITE_BACKOFF,diagnostic=()=>{}}={}){
  const parts=pathParts(path);let stable;
  try{stable=content instanceof Blob?new Blob([await content.arrayBuffer()],{type:content.type}):new Blob([content]);}
  catch(error){error.xaiOperation='source-read';throw error;}
  const expected=await sha256(stable),startedAt=new Date().toISOString();
  async function verified(){const file=await destination(directory,parts,false),fresh=await file.getFile();return await sha256(new Blob([await fresh.arrayBuffer()]))===expected;}
  for(let attempt=0;attempt<=backoff.length;attempt++){
    let stream,stage='open';
    try{
      const file=await destination(directory,parts,true);stream=await file.createWritable({mode:'exclusive'});
      stage='write';await stream.write(stable);
      stage='close';await stream.close();stream=null;
      stage='verify';if(!await verified()){const error=Error('保存后内容与预期不一致。');error.name='WriteVerificationError';throw error;}
      if(attempt)await diagnostic({at:startedAt,path,stage,attempts:attempt+1,outcome:'recovered'});
      return path;
    }catch(error){
      if(stream)await stream.abort().catch(()=>{});
      const transient=TRANSIENT.has(error.name);
      // A close may have committed before reporting an error. Check bytes first
      // so an ambiguous local result does not cause an unnecessary second write.
      if(transient&&(stage==='close'||stage==='verify')){
        try{if(await verified()){await diagnostic({at:startedAt,path,stage,code:error.name,attempts:attempt+1,outcome:'verified-after-error'});return path;}}catch{}
      }
      await diagnostic({at:startedAt,path,stage,code:error.name,attempts:attempt+1,outcome:transient&&attempt<backoff.length?'retry':'failed'});
      if(!transient||attempt===backoff.length){error.xaiOperation='output-write';error.xaiPath=path;error.xaiStage=stage;error.xaiAttempts=attempt+1;throw error;}
      await wait(backoff[attempt]);
    }
  }
}
