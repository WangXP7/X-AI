import {get,permitted} from './storage.js';
import {recoverDownloads} from './download-recovery.js';
import {migrateAutomaticQueue,inspectQueue} from './queue-health.js';
import {pacingKey} from './request-pacing.js';
import {modelProfile} from './models.js';
export class QueueWatchdog{
  constructor(context,onChange=()=>{}){this.context=context;this.onChange=onChange;this.busy=false;this.nextRestartAt=0;}
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      const {project,runner,folder,busyReason}=this.context();if(!project||!runner)return;
      if(busyReason||runner.starting){runner.health={at:Date.now(),code:'local-busy',message:(busyReason||'正在取得队列运行权')+'，结束后自动接续队列'};this.onChange();return;}
      const migrated=migrateAutomaticQueue(project),recovered=recoverDownloads(project);
      if(migrated||recovered){runner.event('queue_migrated',`1.2.3：恢复 ${migrated} 个旧版自动提交意图、${recovered} 个下载检查点`);await runner.persist();}
      const profile=modelProfile(project.jobs.find(j=>j.uid===runner.activeUid)?.profileId);runner.rate=await get('state',pacingKey(profile.platformId||profile.id,'submit'))||{};runner.cooldowns=await get('state','submission-cooldowns')||{};
      let health=inspectQueue(project,runner);
      if(busyReason)health={code:'local-busy',message:busyReason+'，结束后自动接续队列',canStart:false};
      else if(runner.refreshing||runner.assembling)health={code:'busy',message:runner.assembling?'正在拼接，结束后自动接续队列':'正在刷新原任务，结束后自动接续',canStart:false};
      if(health.canStart){
        if(!folder||!await permitted(folder))health={code:'permission',message:'输出目录未授权，队列已保留；授权后自动继续',canStart:false};
        else if(!runner.transport.key&&!project.jobs.some(j=>['download','checking'].includes(j.state)))health={code:'key',message:'生成密钥未启用，启用后自动继续',canStart:false};
        else if(navigator.onLine===false&&!project.jobs.some(j=>['download','checking'].includes(j.state)))health={code:'offline',message:'网络离线，恢复连接后自动继续',canStart:false};
        else if(Date.now()>=this.nextRestartAt){
          this.nextRestartAt=Date.now()+10000;
          runner.event('queue_auto_resumed',health.message);await runner.persist();
          // Do not await the production run: subsequent health probes remain alive.
          runner.start({automatic:true,onlyUids:[]}).catch(error=>{runner.health={at:Date.now(),code:'recovering',message:'自动接续暂未成功：'+error.message};this.onChange();});
        }
      }
      runner.health={...health,at:Date.now()};this.onChange();
    }catch(error){const {runner}=this.context();if(runner)runner.health={at:Date.now(),code:'recovering',message:'自检暂未完成，稍后自动重试：'+error.message};this.onChange();}
    finally{this.busy=false;}
  }
  install(){
    this.timer=setInterval(()=>this.tick(),30000);
    this.wake=()=>this.tick();window.addEventListener('online',this.wake);window.addEventListener('pageshow',this.wake);document.addEventListener('visibilitychange',this.wake);
    return this.tick();
  }
}
