import {LABELS} from './core.js';
import {taskProblem,taskStatus} from './network.js';
export const QUEUE_STAGES=['素材校验','提交任务','排队 / 生成','下载结果','本地校验'];
const READY=new Set(['ready','approved']),ATTENTION=new Set(['unknown','blocked','failed','needs_redo','invalid']);
const ACTIVE=new Set(['submitting','queued','generating','deferred','download','checking']);
export function reportedProgress(value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value==='string'&&!/^\s*\d+(?:\.\d+)?%?\s*$/.test(value))return null;
  if(!['string','number'].includes(typeof value))return null;
  const number=Number(typeof value==='string'?value.trim().replace(/%$/,''):value);
  return Number.isFinite(number)&&number>=0&&number<=100?number:null;
}
export function elapsedText(ms){const seconds=Math.max(0,Math.floor(ms/1000));return seconds<60?seconds+' 秒':seconds<3600?Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':Math.floor(seconds/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分';}
export function queueProgress(project,runner={},at=Date.now()){
  const jobs=project.jobs||[],ready=jobs.filter(j=>READY.has(j.state)).length,attention=jobs.filter(j=>ATTENTION.has(j.state)).length;
  const job=jobs.find(j=>j.uid===runner.activeUid)||jobs.find(j=>ACTIVE.has(j.state))||jobs.find(j=>ATTENTION.has(j.state))||jobs.find(j=>j.state==='pending');
  const busy=!!(runner.running||runner.refreshing||runner.assembling),activity=runner.activity||{},transport=runner.transport||{},problem=job?taskProblem(job):{};
  const nextAt=Math.max(transport.nextAt||0,activity.waitUntil||0),waiting=activity.kind==='waiting';
  const seconds=waiting?Math.max(0,Math.ceil((nextAt-at)/1000)):0;
  const responseAt=job?.attempts?.at(-1)?.polledAt||transport.lastResponseAt;
  const responseMs=responseAt?at-(typeof responseAt==='string'?Date.parse(responseAt):responseAt):null;
  let label,detail,percent=null,indeterminate=false;
  if(runner.assembling){label=activity.label||'正在本地拼接';detail='输入镜头与成片都保存在本地';percent=reportedProgress(activity.percent);indeterminate=percent===null;}
  else if(busy&&activity.kind==='waiting'){label=seconds?`${activity.label||'等待请求间隔'} · ${seconds} 秒后继续`:'正在准备下一次请求';detail=activity.operation==='submit'?'生成提交按独立时间槽排队，查询与下载不占用该间隔':activity.operation==='media'?'仅调整下载频率，原视频与任务编号保留':'按查询节奏跟踪状态，完成后立即下载';indeterminate=true;}
  else if(busy&&activity.kind==='requesting'){label=activity.label||'正在查询服务端';detail=`本次请求已等待 ${elapsedText(at-activity.startedAt)}，最长等待 180 秒`;indeterminate=true;}
  else if(busy&&activity.kind==='recovery'){label=activity.label||'正在自动恢复下载';detail=activity.waitUntil?`预计 ${Math.max(0,Math.ceil((activity.waitUntil-at)/1000))} 秒后自动重试；原任务已保留`:'等待网络恢复，程序会自动继续';indeterminate=true;}
  else if(busy&&activity.kind==='download'){label=activity.label||'正在下载视频';const bytes=activity.bytes||0,total=activity.total||0;detail=`已接收 ${(bytes/1_000_000).toFixed(2)} MB`+(total?` / ${(total/1_000_000).toFixed(2)} MB`:' · 文件总大小未提供');percent=total?Math.min(100,bytes/total*100):null;indeterminate=percent===null;}
  else if(busy&&activity.kind!=='idle'&&activity.label){label=activity.label;detail='浏览器正在处理，请保持页面打开';percent=reportedProgress(activity.percent);indeterminate=percent===null;}
  else if(busy&&runner.localChecks?.size){label=runner.localActivity?.label||'后台校验已下载原片';detail='原片已保存；下一镜可按请求间隔继续，内容审核独立进行';percent=reportedProgress(runner.localActivity?.percent);indeterminate=percent===null;}
  else if(job){label=problem.label||taskStatus(job)||LABELS[job.state]||job.state;detail=problem.label?problem.message:busy?'正在跟踪当前任务':runner.health?.message||'正在检查队列接续条件';percent=problem.stage!==null?null:job.progressKnown===true?reportedProgress(job.progress):null;indeterminate=busy&&percent===null;}
  else{label=jobs.length?'本轮暂无正在处理的任务':'等待任务加入';detail=ready?`已有 ${ready} 镜通过技术校验，内容仍待审核`:'添加分镜后开始队列';}
  if(percent!==null&&['queued','generating'].includes(job?.state)&&!['download','check'].includes(activity.kind))detail+=' · 服务端报告 '+percent.toFixed(1).replace(/\.0$/,'')+'%';
  const updated=responseMs!==null&&Number.isFinite(responseMs)?'最近服务端响应：'+elapsedText(responseMs)+'前':'尚无服务端状态响应';
  const stage=runner.assembling?-1:problem.stage??(READY.has(job?.state)||job?.state==='needs_redo'?5:({pending:0,invalid:0,submitting:1,unknown:1,deferred:1,queued:2,generating:2,download:3,checking:4})[job?.state]??-1);
  return {total:jobs.length,ready,attention,pending:jobs.filter(j=>j.state==='pending'||j.state==='draft').length,active:jobs.filter(j=>ACTIVE.has(j.state)).length,overall:jobs.length?ready/jobs.length*100:0,job,stage,busy,label,detail,percent,indeterminate,seconds,updated,warning:problem.message||'',
    elapsed:job?.attempts?.at(-1)?.submittedAt?'任务已用 '+elapsedText(at-Date.parse(job.attempts.at(-1).submittedAt)):activity.startedAt&&busy?'本阶段已用 '+elapsedText(at-activity.startedAt):'',
    identity:runner.assembling?'本地成片':job?.id||'制作队列'};
}
