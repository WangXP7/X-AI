// First-party RPC boundary. FFmpeg core remains the unmodified shipped vendor.
// An HTTP same-origin worker imports only verified core Blob URLs supplied by
// its owner; no external CDN, platform API, credentials or user URL is loaded.
let engine;
self.onmessage=async({data:{id,type,data}})=>{
  try{
    let result;
    if(type==='LOAD'){
      const {default:createCore}=await import(data.coreURL);
      engine=await createCore({wasmBinary:new Uint8Array(await(await fetch(data.wasmURL)).arrayBuffer()),mainScriptUrlOrBlob:data.coreURL+'#'+btoa(JSON.stringify({wasmURL:data.wasmURL,workerURL:data.coreURL}))});
      engine.setLogger(data=>self.postMessage({type:'LOG',data}));engine.setProgress(data=>self.postMessage({type:'PROGRESS',data}));result=true;
    }else{
      if(!engine)throw Error('not-loaded');
      if(type==='EXEC'){engine.setTimeout(data.timeout);engine.exec(...data.args);result=engine.ret;engine.reset();}
      else if(type==='WRITE_FILE'){engine.FS.writeFile(data.path,data.data);result=true;}
      else if(type==='READ_FILE')result=engine.FS.readFile(data.path,{encoding:data.encoding});
      else if(type==='DELETE_FILE'){engine.FS.unlink(data.path);result=true;}
      else throw Error('unknown-operation');
    }
    self.postMessage({id,type,data:result},result instanceof Uint8Array?[result.buffer]:[]);
  }catch{self.postMessage({id,type:'ERROR',data:{code:type==='LOAD'?'core-initialization':'media-operation'}});}
};
