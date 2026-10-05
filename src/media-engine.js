// A worker can disappear without returning a message. Bound initialization and
// operations, terminate that instance, then let the next queued check recover.
function deadline(work,milliseconds,label,cancel=()=>{}){
  let timer;
  const limit=new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();const error=new Error(label+'超时，已释放解码引擎，原片保留。');error.name='LocalCheckUnavailable';reject(error);},milliseconds);});
  return Promise.race([work,limit]).finally(()=>clearTimeout(timer));
}
export class MediaEngineQueue{
  constructor(factory,{loadTimeout=30000}={}){this.factory=factory;this.loadTimeout=loadTimeout;this.instance=null;this.chain=Promise.resolve();}
  reset(instance=this.instance){try{instance?.terminate();}catch{}if(this.instance===instance)this.instance=null;}
  async engine(){
    if(this.instance)return this.instance;
    let error;
    for(let attempt=0;attempt<2;attempt++){
      let instance;
      try{
        instance=await deadline(Promise.resolve().then(this.factory),this.loadTimeout,'解码模块加载');
        await deadline(instance.load(),this.loadTimeout,'解码引擎初始化',()=>this.reset(instance));
        return this.instance=instance;
      }catch(failure){error=failure;this.reset(instance);}
    }
    error.name='LocalCheckUnavailable';throw error;
  }
  run(work,{timeout=240000}={}){
    const task=this.chain.catch(()=>{}).then(async()=>{
      const instance=await this.engine();
      try{return await deadline(Promise.resolve().then(()=>work(instance)),timeout,'本地媒体处理',()=>this.reset(instance));}
      catch(error){this.reset(instance);throw error;}
    });
    this.chain=task;return task;
  }
}
