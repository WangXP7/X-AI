import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBatch,parseCSV,inspectBatch,resolveSourcePath,referenceList,findAsset} from '../src/batch.js';
const defaults={id:'S',episode:'EP01',seconds:8,mode:'text',aspect:'9:16',assetIds:[],dialogue:'',seed:null};
test('Chinese production headers and all supported CSV delimiters retain quoted multiline prompts',()=>{
  for(const d of [',','\t',';','|','，','；']){
    const text='\uFEFF'+['镜号','集名','时长秒','画面动作','AgnesAI实际提示词','当前图像候选引用','角色五视图引用'].join(d)+'\r\n'+['A01-01','前世','7','draft','"真实'+d+'提示\n词"','C02=图片/熊.png','历史图.png'].join(d);
    const r=parseBatch(text,defaults,[])[0];assert.equal(r.seconds,7);assert.equal(r.prompt,'真实'+d+'提示\n词');assert.equal(r.episodeTitle,'前世');assert.deepEqual(r.assetIds,['图片/熊.png']);assert.equal(r.mode,'reference');assert.equal(inspectBatch(text).ignored[0],'角色五视图引用');
  }
});
test('long CSV is parsed by rows and quoted cell boundaries, not text separators',()=>{
  const text='镜号,提示词\n'+Array.from({length:1000},(_,i)=>`S${i},"长提示\n---\n不是新镜头"`).join('\n');assert.equal(parseBatch(text,defaults,[]).length,1000);assert.throws(()=>parseBatch(text+'\nS1000,多一镜',defaults,[]),/1000/);
});
test('row width and duplicate headers are actionable errors instead of data loss',()=>{
  assert.throws(()=>parseBatch('镜号,提示词\nA,one,two',defaults,[]),/第 2 行有 3 列/);assert.throws(()=>parseCSV('id,prompt,prompt\nA,one,two'),/重名/);assert.throws(()=>parseCSV('id,prompt\nA,"broken'),/未闭合/);
});
test('text recognizes only standalone separators, not punctuation within prompts',()=>{for(const s of ['--','---','===','***','___'])assert.equal(parseBatch('one\n'+s+'\ntwo',defaults,[]).length,2);assert.equal(parseBatch('one -- two; three, four',defaults,[]).length,1);});
test('references accept mappings, arrays and multiple file lists; explicit empty means no references',()=>{
  assert.deepEqual(referenceList('C01=../图片/熊.png; R01=声音/对白.wav'),['C01=../图片/熊.png','R01=声音/对白.wav']);
  const r=parseBatch('[{"prompt":"走路","参考图":"C01","参考声音":"R01"}]',defaults,[])[0];assert.deepEqual(r.assetIds,['C01','R01']);
  assert.deepEqual(parseBatch('[{"prompt":"走路","files":[]}]',{...defaults,assetIds:['previous']},[])[0].assetIds,[]);
  assert.equal(parseBatch('[{"prompt":"走路","files":[]}]',{...defaults,mode:'reference',assetIds:['previous']},[])[0].mode,'text');
});
test('relative paths honor the CSV directory and cannot escape the authorized root',()=>{
  assert.equal(resolveSourcePath('lists/shots.csv','../images/熊.png'),'images/熊.png');assert.equal(resolveSourcePath('shots.csv','.\\images\\熊.png'),'images/熊.png');
  for(const p of ['../../secret.png','D:\\secret.png','https://evil.test/a.png','/etc/passwd'])assert.throws(()=>resolveSourcePath('lists/shots.csv',p));
});
test('source namespace disambiguates same names; mapped optimized version is used',()=>{
  const a={id:'a',name:'熊.png',storage:'source',sources:[{root:'root1',path:'images/熊.png'}],aliases:['C01'],effectiveAssetId:'opt'},b={id:'b',name:'熊.png',sources:[{root:'root2',path:'images/熊.png'}]},opt={id:'opt',name:'熊.png',path:'references/熊.png',derivedFrom:'a',errors:[]};
  assert.throws(()=>findAsset('熊.png',[a,b]),/多个文件/);assert.equal(findAsset('C01',[a,b]).id,'a');
  const result=parseBatch('[{"prompt":"走路","files":["C01=../images/熊.png"]}]',defaults,[a,b,opt],{sourceId:'root1',csvPath:'lists/shots.csv'})[0];assert.deepEqual(result.assetIds,['opt']);assert.deepEqual(result.sourceReferences,['C01=../images/熊.png']);
});
test('short codes match only unambiguous filenames and never silently select a variant',()=>{
  assert.equal(findAsset('C01',[{id:'a',name:'C01_熊.png'}]).id,'a');assert.equal(findAsset('C01',[{id:'b',name:'C010_熊.png'}]),null);assert.throws(()=>findAsset('C01',[{id:'a',name:'C01_熊.png'},{id:'b',name:'C01_熊_V2.png'}]),/多个文件/);
});
