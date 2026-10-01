// Pure metadata rules. Source files are never renamed, copied or overwritten.
export function sourceMetadata(file,extra={},root=crypto.randomUUID()){
  if(extra.derivedFrom)return {...extra};
  const path=file.webkitRelativePath?.split('/').slice(1).join('/')||file.name;
  return {...extra,storage:'source',sources:extra.sources?.length?extra.sources:[{root,rootName:'本次选择的原文件',path}],aliases:[...new Set(extra.aliases||[])]};
}
export function migrateOriginalAssets(project){
  let count=0;
  for(const asset of project.assets){
    if(asset.derivedFrom||asset.storage==='source')continue;
    const oldPath=asset.path;
    asset.storage='source';asset.path=asset.name;
    asset.sources=[{root:project.id,rootName:'旧版原素材（待关联源文件）',path:asset.name}];
    asset.aliases=[...new Set([asset.name,oldPath,...(asset.aliases||[])])];
    asset.legacyPaths=[...new Set([oldPath,...(asset.legacyPaths||[])])];count++;
  }
  if(count)project.events.push({at:new Date().toISOString(),kind:'original_sources_migrated',message:`${count} 项旧版原始素材改为只引用；保留旧路径别名、哈希和历史文件。重新选择原文件后恢复实际源权限。`});
  return count;
}
export function mergeAssetSources(existing,incoming){
  if(existing.storage!=='source'&&existing.path!==incoming.path)existing.legacyPaths=[...new Set([existing.path,...(existing.legacyPaths||[])])];
  existing.storage='source';existing.path=incoming.path;
  existing.sources=[...(incoming.sources||[]),...(existing.sources||[])].filter((s,i,a)=>a.findIndex(x=>x.root===s.root&&x.path===s.path)===i);
  existing.aliases=[...new Set([existing.name,...(existing.aliases||[]),...(incoming.aliases||[])])];
}
