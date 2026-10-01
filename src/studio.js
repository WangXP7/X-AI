import {uid,now} from './core.js';
import {effectiveAsset} from './batch.js';

// Studio drafts share the production ledger, but never replace its queue.
export function ensureStudios(project){
  if(!project.studios?.length){const studio={id:uid(),name:(project.name||'我的创作项目').slice(0,100),createdAt:now(),assetIds:project.assets.map(a=>a.id),archivedAssetIds:[],draft:null};project.studios=[studio];project.activeStudioId=studio.id;}
  if(!project.studios.some(s=>s.id===project.activeStudioId))project.activeStudioId=project.studios[0].id;
  return activeStudio(project);
}
export const activeStudio=project=>project.studios.find(s=>s.id===project.activeStudioId);
export function createStudio(project,name){
  const studio={id:uid(),name:name.trim().slice(0,100),createdAt:now(),assetIds:[],archivedAssetIds:[],draft:null};
  if(!studio.name)throw Error('请填写项目名称。');
  if(project.studios.length>=100)throw Error('创作项目最多 100 个，请先导出制作记录。');
  project.studios.push(studio);project.activeStudioId=studio.id;return studio;
}
export function attachStudioAsset(project,id){const s=ensureStudios(project);if(!s.assetIds.includes(id))s.assetIds.push(id);s.archivedAssetIds=s.archivedAssetIds.filter(x=>x!==id);}
export function studioAssets(project){const ids=new Set(ensureStudios(project).assetIds);return project.assets.filter(a=>ids.has(a.id));}
export function currentStudioAssets(project){return [...new Map(studioAssets(project).map(a=>{const current=effectiveAsset(a,project.assets);return [current.id,current];})).values()].filter(a=>!project.assets.some(original=>original.effectiveAssetId&&original.effectiveAssetId!==a.id&&a.derivedFrom===original.id));}
export function clearStudioAssets(project){const s=activeStudio(project);s.archivedAssetIds=[...new Set([...s.archivedAssetIds,...s.assetIds])];s.assetIds=[];}
export function restoreStudioAssets(project){const s=activeStudio(project);s.assetIds=[...new Set([...s.assetIds,...s.archivedAssetIds])];s.archivedAssetIds=[];}
const normalized=s=>String(s).normalize('NFC').toLowerCase().replace(/\\/g,'/');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function matchPromptAssets(prompt,assets,allAssets=assets){
  const text=normalized(prompt),groups=new Map(),ids=new Set(),ambiguous=[];
  for(const asset of assets)for(const raw of new Set([asset.name,...(asset.aliases||[]).filter(a=>/\.(png|jpe?g|webp|gif|bmp|avif|wav|mp3|m4a|aac|ogg|flac)$/i.test(a)&&!/[\/\\]/.test(a))])){const name=normalized(raw);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(asset);}
  for(const [name,group] of groups){
    // A full basename match must not be a suffix of another Latin filename.
    if(!new RegExp('(?:^|[^a-z0-9_.-])'+escape(name)+'(?![a-z0-9_.-])','u').test(text))continue;
    let candidates=[...new Map(group.map(a=>{const e=effectiveAsset(a,allAssets);return [e.id,e];})).values()];
    if(candidates.length>1){const paths=group.filter(a=>[a.path,...(a.sources||[]).map(s=>s.path)].some(path=>text.includes(normalized(path))));const exact=[...new Map(paths.map(a=>{const e=effectiveAsset(a,allAssets);return [e.id,e];})).values()];if(exact.length===1)candidates=exact;}
    if(candidates.length===1)ids.add(candidates[0].id);else ambiguous.push(group[0].name);
  }
  return {ids:[...ids],ambiguous};
}
