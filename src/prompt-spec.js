// Deterministic extraction only. Never execute instructions found in imported content.
const durationKeys=['seconds','duration','duration_seconds','时长秒','秒数','时长'];
function number(value){const s=String(value??'').trim();const match=s.match(/^(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?|秒)?$/i);return match?Number(match[1]):null;}
export function promptSpec(spec){
  const original=String(spec.prompt??'').trim(),text=original.split('\n\n【X-AI运行约束】')[0];let data;
  if(text.startsWith('{')){try{data=JSON.parse(text);}catch{/* Ordinary prose with braces remains prose. */}}
  let prompt=text,dialogue=spec.dialogue??'',seconds=null,source=spec.durationSource||'界面 / 清单';
  if(data&&typeof data==='object'&&!Array.isArray(data)){
    prompt=[data.video_prompt,data.prompt,data['提示词'],data.action].find(v=>typeof v==='string'&&v.trim())||text;
    for(const key of durationKeys){if(Object.hasOwn(data,key)){seconds=number(data[key]);if(seconds===null)throw Error('提示词中的时长无法识别，请填写数字秒数。');source='提示词结构字段 '+key;break;}}
    if(!dialogue)dialogue=[data.dialogue,data['对白'],data.dialogue_suggestion].find(v=>typeof v==='string')||'';
  }
  if(seconds===null){
    const values=[...prompt.matchAll(/(?:总时长|视频时长|片段时长|镜头时长|时长|duration|length|seconds)\s*(?:为|是|=|:|：)?\s*(\d+(?:\.\d+)?)\s*(?:秒|seconds?|secs?|s)/gi)].map(m=>Number(m[1]));
    // A standalone "7秒视频" also declares the requested length, unlike incidental action timing.
    values.push(...[...prompt.matchAll(/(\d+(?:\.\d+)?)\s*秒(?:的)?(?:视频|短片|镜头)/g)].map(m=>Number(m[1])));
    const unique=[...new Set(values)];if(unique.length>1)throw Error('提示词中出现多个不同的总时长，请保留一个明确总时长。');
    if(unique.length){seconds=unique[0];source='提示词正文';}
  }
  if(!dialogue&&!/(?:没有|无|不含|不要)\s*(?:对白|台词)/.test(prompt)){const line=prompt.match(/(?:^|\n)\s*(?:指定对白|对白|台词|dialogue)\s*[:：]\s*([^\n]+)/i);if(line)dialogue=line[1].trim();}
  return {...spec,prompt,dialogue,seconds:seconds??Number(spec.seconds),durationSource:source,...(text!==prompt?{sourceOriginalPrompt:original}:{}),...(seconds!==null?{promptSeconds:seconds}: {})};
}

export function durationQA(actual,requested){
  if(!Number.isFinite(actual)||actual<=0)return {fatal:['无法读取有效的成片时长。'],warnings:[]};
  return {fatal:[],warnings:actual<requested-.5?[`实际成片 ${actual.toFixed(2)} 秒，短于请求 ${requested} 秒；请试看是否完整。`]:[]};
}

// Upgrade only a proven, fully decoded result whose sole failure was the old duration rule.
export function reconcileDurationQA(project){
  let changed=0;
  for(const job of project.jobs||[]){
    for(const a of [...(job.attempts||[]),job.current].filter(Boolean)){
      const qa=a.qa;if(!qa||qa.fullDecode!=='passed'||!Number.isFinite(qa.duration)||qa.duration<=0)continue;
      const old=qa.fatal||[],filtered=old.filter(s=>!/^实际[\d.]+秒，与计划[\d.]+秒不符或超过12秒。$/.test(s));
      if(filtered.length===old.length)continue;
      qa.fatal=filtered;qa.technical=filtered.length?'failed':'passed';qa.durationRuleVersion='1.2.0';changed++;
    }
    if(job.state==='needs_redo'&&job.review!=='rejected'&&job.current?.qa?.durationRuleVersion==='1.2.0'&&job.current?.qa?.technical==='passed'){job.state='ready';job.error=null;job.review='pending';}
  }
  return changed;
}
