// Cache only the shipped decoder, never user media or authenticated responses.
export const DECODER_ASSETS=[
  {name:'core',path:'../vendor/ffmpeg-core/ffmpeg-core.js',bytes:111804,type:'text/javascript',sha256:'67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3'},
  {name:'wasm',path:'../vendor/ffmpeg-core/ffmpeg-core.wasm',bytes:32232419,type:'application/wasm',sha256:'9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7'}
];
const memory=new Map(),CACHE='x-ai-verified-decoder-v1';
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
async function resource(asset,{signal,onProgress,nonce}){
  if(memory.has(asset.sha256))return memory.get(asset.sha256);
  const key=new URL(asset.path,import.meta.url);key.searchParams.set('sha256',asset.sha256);
  let cache;try{cache=await caches.open(CACHE);}catch{/* Cache denial must not prevent normal loading. */}
  try{
    const cached=await cache?.match(key.href);
    if(cached){const data=await cached.blob();if(await verifiedDecoderAsset(asset,data)){memory.set(asset.sha256,data);onProgress({label:'已读取本机缓存的解码引擎'});return data;}await cache.delete(key.href);}
  }catch{/* An unreadable cache is replaced from the shipped same-origin asset. */}
  signal?.throwIfAborted();const url=new URL(key);url.searchParams.set('load',nonce);
  onProgress({label:asset.name==='wasm'?'正在加载解码引擎 · 0 / 32.23 MB':'正在加载解码启动文件'});
  let response;
  try{response=await fetch(url,{cache:'no-store',credentials:'omit',signal});}catch(e){throw decoderFailure('assets','fetch-'+asset.name,e);}
  if(!response.ok)throw decoderFailure('assets','http-'+response.status+'-'+asset.name);
  const chunks=[],reader=response.body?.getReader();let received=0;
  try{
    if(reader){while(true){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;received+=value.byteLength;if(received>asset.bytes)throw decoderFailure('assets','size-'+asset.name);chunks.push(value);if(asset.name==='wasm')onProgress({label:`正在加载解码引擎 · ${(received/1e6).toFixed(2)} / 32.23 MB`,bytes:received,total:asset.bytes});}}
    else chunks.push(await response.arrayBuffer());
  }catch(e){await reader?.cancel().catch(()=>{});throw e.name==='LocalCheckUnavailable'?e:decoderFailure('assets','read-'+asset.name,e);}
  const data=new Blob(chunks,{type:asset.type});
  if(!await verifiedDecoderAsset(asset,data))throw decoderFailure('assets','integrity-'+asset.name);
  signal?.throwIfAborted();memory.set(asset.sha256,data);
  try{await cache?.put(key.href,new Response(data,{headers:{'Content-Type':asset.type}}));}catch{/* Full/disabled cache affects the next cold start, not this verified engine. */}
  return data;
}
export async function decoderResources(options){
  const files=[];for(const asset of DECODER_ASSETS)files.push(await resource(asset,options));return files;
}
