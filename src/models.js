// Only configured integrations appear here. PavoAI is a composer, not a provider.
export const MODEL_PROFILES=[{
  id:'agnes-video-2.5-flash',platformId:'agnes',platformName:'AgnesAI',model:'agnes-video-2.5-flash',modelLabel:'Agnes Video 2.5 Flash',version:'2.5',resolution:'720P',adapter:'agnes',
  modes:{text:{minSeconds:4,maxSeconds:12,step:1},reference:{minSeconds:4,maxSeconds:12,step:1},keyframe:{minSeconds:4,maxSeconds:12,step:1}},
  references:{maxImages:5,maxAudio:3,minAudioSeconds:2,maxAudioSeconds:12},
}];
export const DEFAULT_PROFILE_ID=MODEL_PROFILES[0].id;
export function modelProfile(id=DEFAULT_PROFILE_ID){const profile=MODEL_PROFILES.find(p=>p.id===id);if(!profile)throw Error('此视频生成平台或模型尚未配置，请选择可用模型。');return profile;}
export function modelCapability(profileId,mode='reference'){const profile=modelProfile(profileId),limits=profile.modes[mode];if(!limits)throw Error(`${profile.platformName} 的 ${profile.modelLabel} 不支持此生成模式。`);return {...limits,profile};}
export function modelOptionLabel(profileId,mode='reference'){const {profile,maxSeconds}=modelCapability(profileId,mode);return `${profile.platformName} · ${profile.modelLabel} · ${profile.resolution} · 此模式请求最长 ${maxSeconds} 秒`;}
export function requestDurationValid(seconds,profileId,mode){const c=modelCapability(profileId,mode);return Number.isFinite(Number(seconds))&&Number(seconds)>=c.minSeconds&&Number(seconds)<=c.maxSeconds&&Math.abs((Number(seconds)-c.minSeconds)/c.step-Math.round((Number(seconds)-c.minSeconds)/c.step))<1e-7;}
