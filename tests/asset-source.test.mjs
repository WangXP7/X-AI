import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceMetadata,migrateOriginalAssets,mergeAssetSources} from '../src/asset-source.js';
import {makeProject,newJob,validateProjectFile,friendlyError} from '../src/core.js';
import {findAsset,effectiveAsset} from '../src/batch.js';

test('all original selections use exact source names, while transforms stay derived',()=>{
  const file={name:'A17_林间_参考V1.wav'};
  const meta=sourceMetadata(file,{},'selection');
  assert.equal(meta.storage,'source');assert.equal(meta.sources[0].path,file.name);
  const directory=sourceMetadata({...file,webkitRelativePath:'project/sounds/'+file.name},{},'folder');
  assert.equal(directory.sources[0].path,'sounds/'+file.name);
  const explicit={storage:'source',sources:[{root:'csv',rootName:'剧本',path:'声音/'+file.name}],aliases:['A17']};
  assert.equal(sourceMetadata(file,explicit).sources[0].path,explicit.sources[0].path);
  assert.equal(sourceMetadata(file,{derivedFrom:'original'}).storage,undefined);
});

test('legacy hash-prefixed originals migrate without changing ID, bytes or historical attempts',()=>{
  const p=makeProject(),hash='a'.repeat(64);
  p.assets=[{id:'original',kind:'image',name:'角色.png',path:'references/abcdef123456_角色.png',blobKey:'asset:original',sha256:hash,bytes:20,errors:[],effectiveAssetId:'optimized'},
    {id:'optimized',kind:'image',name:'角色.png',path:'references/optimized/original/version/角色.png',blobKey:'asset:optimized',sha256:'b'.repeat(64),bytes:10,errors:[],derivedFrom:'original'}];
  p.jobs=[newJob({id:'S01',episode:'EP01',seconds:12,aspect:'16:9',mode:'reference',prompt:'角色.png',assetIds:['original']})];
  p.jobs[0].attempts=[{number:1,videoId:'old-id',snapshot:{assetIds:['original'],path:'references/abcdef123456_角色.png'}}];
  const before=JSON.stringify(p.jobs);
  assert.equal(migrateOriginalAssets(p),1);assert.equal(migrateOriginalAssets(p),0);
  assert.equal(p.assets[0].path,'角色.png');assert.equal(p.assets[0].sha256,hash);
  assert.equal(p.assets[1].path,'references/optimized/original/version/角色.png');
  assert.equal(findAsset('references/abcdef123456_角色.png',p.assets)?.id,'original');
  assert.equal(effectiveAsset(findAsset('角色.png',p.assets),p.assets).id,'optimized');
  assert.equal(JSON.stringify(p.jobs),before);validateProjectFile(p);
});

test('reselection keeps identity and joins exact source paths and aliases',()=>{
  const a={id:'old',storage:'source',name:'原名.png',path:'原名.png',sources:[{root:'old',rootName:'旧',path:'原名.png'}],aliases:['references/123_原名.png']};
  mergeAssetSources(a,{path:'图片/原名.png',sources:[{root:'new',rootName:'新',path:'图片/原名.png'}],aliases:['C01']});
  assert.equal(a.id,'old');assert.equal(a.path,'图片/原名.png');assert.equal(a.sources[0].root,'new');
  assert.ok(a.aliases.includes('references/123_原名.png'));assert.ok(a.aliases.includes('C01'));
});

test('file state failures provide concise actions without raw browser English',()=>{
  assert.match(friendlyError(new DOMException('An operation that depends on state','InvalidStateError')),/重新选择原文件/);
  const e=new DOMException('state changed','InvalidStateError');e.xaiOperation='output-write';e.xaiPath='project.json';
  assert.match(friendlyError(e),/project.json/);assert.match(friendlyError(e),/重试保存/);
});
