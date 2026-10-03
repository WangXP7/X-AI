// A static Pages page cannot read a CDN without CORS. Use only the explicitly
// configured local media service; no port scan, public proxy or API-key relay.
const PROTOCOL='x-ai-media-v1',CDN='cos-platform-outputs.agnes-ai.cn';
export function relayDiagnostic(value){return Object.fromEntries(['state','phase','reason','permission','status','failure','checkedAt'].filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));}
export function relayEndpoint(config,pageOrigin){
  if(config?.protocol!==PROTOCOL||!Array.isArray(config.pageOrigins)||!config.pageOrigins.includes(pageOrigin))return null;
  try{const url=new URL(config.endpoint);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/'))return null;return url.href;}catch{return null;}
}
export class AutomaticMediaRelay{
  constructor(){this.cached=null;this.nextProbe=0;}
  failed(){this.cached=null;this.nextProbe=0;}
  async discover(mediaUrl){
    const url=new URL(mediaUrl);
    if(location.protocol!=='https:'||url.hostname!==CDN)return {state:'not-applicable'};
    if(this.cached?.expiresAt>Date.now()+30000)return this.cached;
    if(this.nextProbe>Date.now())return this.cached||{state:'unavailable'};
    this.nextProbe=Date.now()+30000;
    let state='unavailable',phase='configuration',permission='unsupported';const checkedAt=new Date().toISOString();
    try{
      const response=await fetch(new URL('../media-relay.json',import.meta.url),{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(4000)});
      const endpoint=response.ok?relayEndpoint(await response.json(),location.origin):null;
      if(!endpoint)return this.cached={state:'not-configured',phase,checkedAt};
      phase='permission';
      try{permission=(await navigator.permissions.query({name:'local-network-access'})).state;if(permission==='denied')return this.cached={state:'permission-denied',phase,permission,checkedAt};}catch{}
      phase='session';
      const result=await fetch(new URL('__xai_media_session',endpoint),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(4000)});
      if(!result.ok)return this.cached={state:'unavailable',phase,reason:'session_rejected',status:result.status,permission,checkedAt};
      const data=await result.json();
      if(data.protocol!==PROTOCOL||!/^\d+\.[a-f0-9]{64}$/.test(data.token)||!Number.isFinite(data.expiresAt)||data.expiresAt<=Date.now())return this.cached={state:'incompatible',phase,permission,checkedAt};
      return this.cached={state:'ready',phase,permission,checkedAt,endpoint:new URL('__xai_media',endpoint).href,token:data.token,expiresAt:data.expiresAt};
    }catch(error){
      try{permission=(await navigator.permissions.query({name:'local-network-access'})).state;if(permission==='denied')state='permission-denied';}catch{}
      return this.cached={state,phase,permission,checkedAt,reason:phase==='session'?'session_unreachable':'configuration_unreadable',failure:error.name};
    }
  }
}
