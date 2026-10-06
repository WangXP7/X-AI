import {decoderResources,decoderFailure} from './decoder-assets.js';
import {APP_VERSION} from './runtime-version.js';
// No lazy vendor-module graph in the page: failed ESM imports are sticky there.
// Each replacement owns a new worker/module map and a unique startup URL.
export class MediaDecoder{
  constructor(files,{nonce=crypto.randomUUID()}={}){
    this.urls=files.map(file=>URL.createObjectURL(file));this.nonce=nonce;
    this.worker=null;this.pending=new Map();this.listeners={log:new Set(),progress:new Set()};this.sequence=0;this.loaded=false;
  }
  fail(error){this.loaded=false;for(const {reject} of this.pending.values())reject(error);this.pending.clear();this.worker?.terminate();this.worker=null;}
  terminate(){this.fail(decoderFailure('operation','terminated'));for(const url of this.urls)URL.revokeObjectURL(url);this.urls=[];}
  on(name,fn){this.listeners[name]?.add(fn);}
  off(name,fn){this.listeners[name]?.delete(fn);}
  request(type,data,transfer=[]){
    if(!this.worker)return Promise.reject(decoderFailure('worker','not-started'));
    return new Promise((resolve,reject)=>{const id=++this.sequence;this.pending.set(id,{resolve,reject});try{this.worker.postMessage({id,type,data},transfer);}catch(e){this.pending.delete(id);reject(decoderFailure('operation','post-message',e));}});
  }
  async load(){
    const url=new URL('./decoder-worker.js',import.meta.url);url.searchParams.set('v',APP_VERSION);url.searchParams.set('load',this.nonce);
    try{this.worker=new Worker(url,{type:'module'});}catch(e){throw decoderFailure('worker','construction',e);}
    this.worker.onerror=e=>{e.preventDefault();this.fail(decoderFailure('worker','script-error'));};
    this.worker.onmessageerror=()=>this.fail(decoderFailure('worker','message-error'));
    this.worker.onmessage=({data:{id,type,data}})=>{
      if(type==='LOG'||type==='PROGRESS'){for(const fn of this.listeners[type.toLowerCase()]||[])fn(data);return;}
      const request=this.pending.get(id);if(!request)return;this.pending.delete(id);
      if(type==='ERROR'){const error=decoderFailure(this.loaded?'operation':'initialize',data?.code||'worker-rejected');request.reject(error);}
      else request.resolve(data);
    };
    await this.request('LOAD',{coreURL:this.urls[0],wasmURL:this.urls[1]});this.loaded=true;
  }
  exec(args,timeout=-1){return this.request('EXEC',{args,timeout});}
  writeFile(path,data){return this.request('WRITE_FILE',{path,data},data instanceof Uint8Array?[data.buffer]:[]);}
  readFile(path,encoding='binary'){return this.request('READ_FILE',{path,encoding});}
  deleteFile(path){return this.request('DELETE_FILE',{path});}
}
export async function createDecoder(options){const files=await decoderResources(options);options.signal?.throwIfAborted();return new MediaDecoder(files,options);}
