import test from 'node:test';
import assert from 'node:assert/strict';
import {makeProject,validateProjectFile} from '../src/core.js';
import {ensureStudios,createStudio,attachStudioAsset,studioAssets,currentStudioAssets,clearStudioAssets,restoreStudioAssets,matchPromptAssets} from '../src/studio.js';
import {findAsset,effectiveAsset} from '../src/batch.js';
const original={id:'original',name:'C02_齐天大圣.png',kind:'image',path:'图片/C02_齐天大圣.png'};
const derived={id:'optimized',name:original.name,kind:'image',derivedFrom:'original',path:'references/optimized/original/revision/'+original.name,errors:[]};
test('studio project switching and reversible library clearing preserve the global production ledger',()=>{
  const p=makeProject();p.assets=[original];p.jobs=[{id:'S01',state:'queued',attempts:[{videoId:'remote-existing'}]}];p.episodes=[{id:'EP01',path:'episodes/EP01.mp4'}];ensureStudios(p);
  const before=JSON.stringify({jobs:p.jobs,episodes:p.episodes,assets:p.assets}),first=p.activeStudioId;
  const s=createStudio(p,'全新创作');assert.deepEqual(studioAssets(p),[]);attachStudioAsset(p,original.id);clearStudioAssets(p);assert.equal(studioAssets(p).length,0);restoreStudioAssets(p);assert.equal(studioAssets(p).length,1);p.activeStudioId=first;
  assert.equal(JSON.stringify({jobs:p.jobs,episodes:p.episodes,assets:p.assets}),before);assert.notEqual(s.id,first);
});
test('current library resolves optimized chains while originals and histories remain intact',()=>{const p=makeProject();p.assets=[{...original,effectiveAssetId:derived.id},derived];ensureStudios(p);assert.deepEqual(currentStudioAssets(p).map(a=>a.id),[derived.id]);assert.equal(studioAssets(p).length,2);assert.equal(findAsset(original.name,p.assets).id,original.id);assert.equal(effectiveAsset(findAsset(original.name,p.assets),p.assets).id,derived.id);});
test('prompt association requires full filenames and does not guess among different sources',()=>{
  const assets=[{...original,effectiveAssetId:derived.id},derived];assert.deepEqual(matchPromptAssets('参考 '+original.name+'，走进森林',assets).ids,[derived.id]);assert.deepEqual(matchPromptAssets('参考 X'+original.name,assets).ids,[]);
  const another={...original,id:'other',path:'其它/'+original.name};const ambiguous=matchPromptAssets('参考 '+original.name,[original,another]);assert.deepEqual(ambiguous.ids,[]);assert.equal(ambiguous.ambiguous.length,1);
  assert.deepEqual(matchPromptAssets('参考 图片/'+original.name,[original,another]).ids,['original']);
});
test('new studio metadata validates and unsafe membership / drafts fail before restore',()=>{const p=makeProject();ensureStudios(p);assert.equal(validateProjectFile(p),p);const s=p.studios[0];s.assetIds.push('missing');assert.throws(()=>validateProjectFile(p));s.assetIds=[];s.draft={batchMode:false,fields:{prompt:'安全草稿'},selected:[],batchSelected:[]};assert.equal(validateProjectFile(p),p);s.draft.selected=['missing'];assert.throws(()=>validateProjectFile(p));});
