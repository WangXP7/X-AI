function unavailable(message,stage,code){const error=new Error(message);error.name='LocalCheckUnavailable';error.decoderDiagnostic={stage,code,at:new Date().toISOString()};return error;}
function deadline(work,milliseconds,label,cancel=()=>{}){
  let timer;
  const limit=new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(unavailable(label+'超时，已释放解码引擎，原片保留。',label==='解码文件加载'?'assets':label==='本地媒体处理'?'operation':'initialize','timeout'));},milliseconds);});
  return Promise.race([work,limit]).finally(()=>clearTimeout(timer));
}
export class MediaEngineQueue{
  constructor(factory,{loadTimeout=30000,factoryTimeout=120000,retryDelay=30000}={}){Object.assign(this,{factory,loadTimeout,factoryTimeout,retryDelay});this.instance=null;this.chain=Promise.resolve();this.pending=0;this.retryAt=0;}
  reset(instance=this.instance){try{instance?.terminate();}catch{}if(this.instance===instance)this.instance=null;}
  async engine(onProgress){
    if(this.instance)return this.instance;
    if(this.retryAt>Date.now())throw this.failure;
    let error;
    for(let attempt=0;attempt<2;attempt++){
      let instance,expired=false;const controller=new AbortController();
      try{
        onProgress({label:attempt?'正在自动重建解码引擎':'正在准备本地解码引擎'});
        const factory=Promise.resolve().then(()=>this.factory({attempt,signal:controller.signal,onProgress,nonce:globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+attempt})).then(value=>{if(expired){this.reset(value);throw unavailable('解码文件加载超时，稍后自动继续。','assets','timeout');}return value;});
        instance=await deadline(factory,this.factoryTimeout,'解码文件加载',()=>{expired=true;controller.abort();});
        onProgress({label:'正在启动本地解码进程'});
        await deadline(instance.load(),this.loadTimeout,'解码引擎初始化',()=>this.reset(instance));
        this.failure=null;this.retryAt=0;return this.instance=instance;
      }catch(failure){error=failure instanceof Error?failure:unavailable('解码引擎暂不可用。','initialize','load-error');this.reset(instance);controller.abort();}
    }
    error.name='LocalCheckUnavailable';this.retryAt=Date.now()+this.retryDelay;error.retryAt=this.retryAt;this.failure=error;throw error;
  }
  run(work,{timeout=240000,onProgress=()=>{}}={}){
    if(this.pending)onProgress({label:`本地校验排队 · 前方还有 ${this.pending} 项`});this.pending++;
    const task=this.chain.catch(()=>{}).then(async()=>{
      const instance=await this.engine(onProgress);
      try{return await deadline(Promise.resolve().then(()=>work(instance)),timeout,'本地媒体处理',()=>this.reset(instance));}
      catch(error){this.reset(instance);throw error;}
    }).finally(()=>{this.pending--;});
    this.chain=task;return task;
  }
}
