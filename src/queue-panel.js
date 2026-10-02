import {queueProgress,reportedProgress,QUEUE_STAGES} from './queue-progress.js';
import {LABELS} from './core.js';
import {taskProblem} from './network.js';
const $=id=>document.getElementById(id);
const percentText=value=>value.toFixed(1).replace(/\.0$/,'')+'%';
export class QueuePanel{
  constructor(context){this.context=context;this.updatedAt=null;$('queue-stages').replaceChildren(...QUEUE_STAGES.map(label=>{const item=document.createElement('li');item.textContent=label;return item;}));}
  update(){
    const {project,runner}=this.context();if(!project||!runner)return;const p=queueProgress(project,runner);
    for(const [id,value] of Object.entries({'queue-total':p.total,'queue-ready':p.ready,'queue-active':p.active,'queue-pending':p.pending,'queue-attention':p.attention,'queue-phase':p.label,'queue-phase-detail':p.detail,'queue-current-name':p.identity,'queue-elapsed':p.elapsed,'queue-updated':p.updated,'queue-overall-label':`${p.ready} / ${p.total} 镜已就绪 · ${p.overall.toFixed(1).replace(/\.0$/,'')}%`}))$(id).textContent=value;
    $('queue-live').textContent=p.busy?'实时跟踪中':'等待操作';$('queue-progress-panel').classList.toggle('is-active',p.busy);$('queue-progress-panel').classList.toggle('is-empty',p.total===0);
    const overall=$('queue-overall-bar');overall.value=p.ready;overall.max=Math.max(1,p.total);
    this.meter($('queue-current-bar'),p.percent,p.indeterminate);
    $('queue-current-percent').textContent=p.percent===null?(p.busy?'处理中':'—'):percentText(p.percent);
    for(const [i,item] of [...$('queue-stages').children].entries()){item.classList.toggle('done',i<p.stage);item.classList.toggle('current',i===p.stage);item.setAttribute('aria-current',i===p.stage?'step':'false');}
    $('queue-notice').textContent=p.warning?`${p.identity} · ${p.warning}`:runner.pauseNew?'已暂停新提交；当前任务仍会完成查询、下载和校验。':p.total?'页面保持打开时自动追踪。刷新会保留原任务编号，并遵守请求间隔。':'添加分镜后开始；关闭页面会暂停本地追踪。';$('queue-notice').classList.toggle('error',!!p.warning);
    $('queue-refreshed').textContent=this.updatedAt?'页面刷新于 '+new Date(this.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}):'阶段与倒计时每秒更新';
    $('refresh-queue').disabled=runner.refreshing;$('refresh-queue').textContent=runner.refreshing?'↻ 正在刷新…':'↻ 刷新状态';
    $('start-queue').disabled=runner.running||runner.refreshing||runner.assembling;$('start-queue').textContent=runner.running?'队列运行中':runner.refreshing?'正在刷新状态':'开始 / 继续队列 ▶';
    for(const element of document.querySelectorAll('[data-job-progress]')){
      const job=project.jobs.find(j=>j.uid===element.dataset.jobProgress);if(!job)continue;
      const current=job.uid===p.job?.uid,percent=['ready','approved'].includes(job.state)?100:taskProblem(job).stage!==null?null:current?p.percent:job.progressKnown===true?reportedProgress(job.progress):null;
      element.querySelector('span').textContent=current&&p.busy?p.label:taskProblem(job).label||LABELS[job.state]||job.state;
      element.querySelector('b').textContent=percent===null?'':percentText(percent);
      this.meter(element.querySelector('progress'),['ready','approved'].includes(job.state)?100:percent,current&&p.busy&&percent===null);
    }
  }
  meter(element,value,animated){if(value===null)element.removeAttribute('value');else element.value=value;element.classList.toggle('is-still',value===null&&!animated);element.setAttribute('aria-valuetext',value===null?(animated?'处理中，未提供百分比':'暂无进度'):percentText(value));}
}
