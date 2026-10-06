// Cache only the shipped decoder, never user media or authenticated responses.
import {DECODER_PART_SIZE,DECODER_PART_HASHES} from './decoder-parts.js';
export const DECODER_ASSETS=[
  {name:'core',path:'../vendor/ffmpeg-core/ffmpeg-core.js',bytes:111804,type:'text/javascript',sha256:'67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3'},
  {name:'wasm',path:'../vendor/ffmpeg-core/ffmpeg-core.wasm',bytes:32232419,type:'application/wasm',sha256:'9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7'}
];
const memory=new Map(),parts=new Map(),CACHE='x-ai-verified-decoder-v1';
export function decoderFailure(stage,code,cause){
  const error=new Error(({assets:'解码引擎文件暂未加载完成',worker:'解码进程启动未完成',initialize:'解码引擎初始化未完成',operation:'本地解码未完成'})[stage]||'本地校验暂未完成');
  error.name='LocalCheckUnavailable';error.cause=cause;
  error.decoderDiagnostic={stage,code,at:new Date().toISOString()};return error;
}
export async function verifiedDecoderAsset(asset,blob){
  if(blob.size!==asset.bytes)return false;
  const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('')===asset.sha256;
}
export async function verifiedDecoderPart(index,blob){
  const wasm=DECODER_ASSETS[1],length=Math.min(DECODER_PART_SIZE,wasm.bytes-index*DECODER_PART_SIZE);
  if(!Number.isInteger(index)||index<0||!DECODER_PART_HASHES[index]||blob.size!==length)return false;
  const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('')===DECODER_PART_HASHES[index];
}
async function resource(asset,{signal,onProgress=()=>{},nonce}={}){
  if(memory.has(asset.sha256))return memory.get(asset.sha256);
  const key=new URL(asset.path,import.meta.url);key.searchParams.set('sha256',asset.sha256);
  let cache;try{cache=await caches.open(CACHE);}catch{/* Cache denial must not prevent normal loading. */}
  try{
    const cached=await cache?.match(key.href);
    if(cached){const data=await cached.blob();if(await verifiedDecoderAsset(asset,data)){memory.set(asset.sha256,data);onProgress({label:'已读取本机缓存的解码引擎'});return data;}await cache.delete(key.href);}
  }catch{/* An unreadable cache is replaced from the shipped same-origin asset. */}
  signal?.throwIfAborted();let transferBytes=0,shown=0;
  const report=bytes=>{shown=Math.max(shown,Math.min(bytes,asset.bytes));onProgress({label:asset.name==='wasm'?`正在加载解码引擎 · ${(shown/1e6).toFixed(2)} / 32.23 MB`:'正在加载解码启动文件',asset:asset.name,bytes:shown,transferBytes,total:asset.bytes});};
  const fetchAsset=async range=>{
    signal?.throwIfAborted();const url=new URL(key);url.searchParams.set('load',nonce);if(range)url.searchParams.set('part',range.index);
    let response;try{response=await fetch(url,{cache:'no-store',credentials:'omit',signal,headers:range?{Range:`bytes=${range.start}-${range.end}`}:{}});}catch(e){throw decoderFailure('assets','fetch-'+asset.name,e);}
    const fail=code=>{response.body?.cancel().catch(()=>{});throw decoderFailure('assets',code);};
    if(!response.ok)fail('http-'+response.status+'-'+asset.name);
    if(range&&response.status===206&&response.headers.get('Content-Range')!==`bytes ${range.start}-${range.end}/${asset.bytes}`)fail('range-'+asset.name);
    if(response.status!==200&&(!range||response.status!==206))fail('range-'+asset.name);
    return response;
  };
  const stream=async(response,limit,consume)=>{
    const reader=response.body?.getReader();let received=0;
    try{
      if(reader){while(true){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;received+=value.byteLength;transferBytes+=value.byteLength;if(received>limit)throw decoderFailure('assets','size-'+asset.name);await consume(value,received);}}
      else{const value=new Uint8Array(await response.arrayBuffer());received=value.length;transferBytes+=received;if(received>limit)throw decoderFailure('assets','size-'+asset.name);await consume(value,received);}
      if(received!==limit)throw decoderFailure('assets','size-'+asset.name);
    }catch(e){reader?.cancel().catch(()=>{});throw e.name==='LocalCheckUnavailable'?e:decoderFailure('assets','read-'+asset.name,e);}finally{try{reader?.releaseLock();}catch{}}
  };
  let data;
  if(asset.name!=='wasm'){
    const chunks=[];report(0);await stream(await fetchAsset(),asset.bytes,(value,received)=>{chunks.push(value);report(received);});data=new Blob(chunks,{type:asset.type});
  }else{
    const saved=new Array(DECODER_PART_HASHES.length),partKey=i=>{const url=new URL(key);url.searchParams.set('verified-part',i);return url.href;};
    let verified=0;
    for(let i=0;i<saved.length;i++){
      let part=parts.get(i);if(!part)try{const cached=await cache?.match(partKey(i));if(cached){part=await cached.blob();if(!await verifiedDecoderPart(i,part)){await cache.delete(partKey(i));part=null;}}}catch{part=null;}
      if(part){saved[i]=part;parts.set(i,part);verified+=part.size;}
    }
    report(verified);
    const keep=async(i,part)=>{
      if(!await verifiedDecoderPart(i,part))throw decoderFailure('assets','integrity-part-'+i);
      signal?.throwIfAborted();if(!saved[i])verified+=part.size;saved[i]=part;parts.set(i,part);report(verified);
      try{await cache?.put(partKey(i),new Response(part));}catch{/* Memory resume still works when persistent storage is unavailable. */}
    };
    for(let i=0;i<saved.length;i++){
      if(saved[i])continue;
      const start=i*DECODER_PART_SIZE,end=Math.min(start+DECODER_PART_SIZE,asset.bytes)-1,response=await fetchAsset({index:i,start,end});
      if(response.status===206){const chunks=[],base=verified;await stream(response,end-start+1,(value,received)=>{chunks.push(value);report(base+received);});await keep(i,new Blob(chunks));}
      else{
        // Servers without Range support stream the full binary once, checkpointing
        // verified parts as they arrive. Never splice unverified partial responses.
        let index=0,buffer=new Uint8Array(0);
        await stream(response,asset.bytes,async(value,received)=>{
          report(received);const merged=new Uint8Array(buffer.length+value.length);merged.set(buffer);merged.set(value,buffer.length);buffer=merged;
          while(index<saved.length){const size=Math.min(DECODER_PART_SIZE,asset.bytes-index*DECODER_PART_SIZE);if(buffer.length<size)break;await keep(index,new Blob([buffer.slice(0,size)]));buffer=buffer.slice(size);index++;}
        });break;
      }
    }
    data=new Blob(saved,{type:asset.type});
  }
  if(!await verifiedDecoderAsset(asset,data))throw decoderFailure('assets','integrity-'+asset.name);
  signal?.throwIfAborted();memory.set(asset.sha256,data);
  let cachedFull=false;try{if(cache){await cache.put(key.href,new Response(data,{headers:{'Content-Type':asset.type}}));cachedFull=true;}}catch{/* Full/disabled cache affects the next cold start, not this verified engine. */}
  if(asset.name==='wasm'){
    parts.clear();if(cachedFull)for(let i=0;i<DECODER_PART_HASHES.length;i++){const part=new URL(key);part.searchParams.set('verified-part',i);try{await cache.delete(part.href);}catch{}}
  }
  return data;
}
export async function decoderResources(options){
  const files=[];for(const asset of DECODER_ASSETS)files.push(await resource(asset,options));return files;
}
