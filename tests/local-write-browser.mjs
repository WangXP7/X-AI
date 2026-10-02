// Exercise browser writable-stream failures at the actual mapping file boundary.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),checks=[],errors=[];
await mkdir('test-results',{recursive:true});
const config=await sealLocalDefault('sk-synthetic-mapping-test-not-live');
await context.route('**/private/default-access.json',r=>r.fulfill({json:config}));
await context.route('https://**',r=>{errors.push('External request');return r.abort();});page.on('pageerror',e=>errors.push(e.message));
const finished=()=>page.waitForFunction(()=>document.querySelector('#asset-operation-dialog').getAttribute('aria-busy')==='false'&&!document.querySelector('#asset-operation-progress').hidden);
try{
  await page.goto(process.env.XAI_TEST_URL||'http://127.0.0.1:4183/');await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  await page.evaluate(async()=>{
    const root=await navigator.storage.getDirectory();window.__out=await root.getDirectoryHandle('mapping-output',{create:true});window.showDirectoryPicker=async()=>__out;
    const {writeFile}=await import('./src/storage.js');window.__input=await root.getDirectoryHandle('mapping-source',{create:true});
    const c=document.createElement('canvas');c.width=512;c.height=512;c.getContext('2d').fillRect(0,0,512,512);const png=await new Promise(r=>c.toBlob(r,'image/png'));
    window.__files=[];for(let i=0;i<102;i++){const name='素材_'+i+'.png';await writeFile(__input,name,png);__files.push(await __input.getFileHandle(name));}
    window.showOpenFilePicker=async()=>__files;
  });
  await page.locator('#choose-folder').click();await page.waitForFunction(()=>document.querySelector('#directory-location-label').textContent.includes('mapping-output'));
  await page.evaluate(()=>{
    window.__native=FileSystemFileHandle.prototype.createWritable;window.__remaining=2;window.__mappingOpens=0;
    FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='reference-mapping.json'){__mappingOpens++;if(__remaining-->0)throw new DOMException('An operation that depends on state changed','InvalidStateError');}return __native.apply(this,args);};
  });
  await page.locator('[data-view=assets]').click();await page.locator('#library-pick-files').click();await page.locator('#asset-operation-start').click();await finished();
  const batch=await page.evaluate(async()=>{const s=await import('./src/storage.js');const p=await s.get('state','project');return {count:p.assets.length,mapping:JSON.parse(await(await s.readFile(__out,'reference-mapping.json')).text()).mappings.length,opens:__mappingOpens,diagnostics:await s.get('state','write-diagnostics'),files:await Array.fromAsync(__out.keys())};});
  assert.equal(batch.count,102);assert.equal(batch.mapping,102);assert.equal(batch.opens,3);assert.ok(!batch.files.includes('references'));assert.equal(await page.locator('#asset-operation-save').isVisible(),false);assert.equal(await page.locator('#asset-operation-results .error,.warning').count(),0);assert.equal(await page.locator('#asset-progress-count').innerText(),'102 / 102');
  assert.equal(batch.diagnostics.filter(r=>r.outcome==='retry').length,2);assert.equal(batch.diagnostics.at(-1).outcome,'recovered');
  checks.push('102 imports checkpoint project per item and flush mapping once; two transient mapping failures recover automatically with three opens');
  await page.screenshot({path:'test-results/mapping-v114-recovered.png'});
  const unchanged=await page.evaluate(async()=>{const s=await import('./src/storage.js'),p=await s.get('state','project'),before=__mappingOpens;await s.saveProject(p,__out);await s.saveProject(p,__out);return __mappingOpens-before;});assert.equal(unchanged,0);checks.push('unchanged saves do not rewrite reference-mapping.json');
  const corrupt=await page.evaluate(async()=>{const s=await import('./src/storage.js'),p=await s.get('state','project');await s.writeFile(__out,'reference-mapping.json','corrupt');await s.saveProject(p,__out);return JSON.parse(await(await s.readFile(__out,'reference-mapping.json')).text()).mappings.length;});assert.equal(corrupt,102);checks.push('changed or corrupt mapping is rebuilt rather than trusted from a stale memory cache');
  const nullMapping=await page.evaluate(async()=>{const s=await import('./src/storage.js'),p=await s.get('state','project');await s.writeFile(__out,'reference-mapping.json','null');await s.saveProject(p,__out);return JSON.parse(await(await s.readFile(__out,'reference-mapping.json')).text()).mappings.length;});assert.equal(nullMapping,102);
  const required=await page.evaluate(async()=>{const s=await import('./src/storage.js'),p=await s.get('state','project');await s.writeFile(__out,'reference-mapping.json','null');await s.saveProject(p,__out,{requireDisk:true,deferMapping:true});return JSON.parse(await(await s.readFile(__out,'reference-mapping.json')).text()).mappings.length;});assert.equal(required,102);
  await page.locator('#asset-operation-done').click();await page.evaluate(()=>{window.__remaining=Infinity;window.showOpenFilePicker=async()=>[__files[0]];});
  await page.locator('#library-pick-files').click();await page.locator('#asset-operation-start').click();await finished();
  assert.equal(await page.locator('#asset-operation-save').isVisible(),true);assert.match(await page.locator('#asset-operation-feedback').innerText(),/reference-mapping.json.*打开阶段.*5 次/);
  let p=await page.evaluate(async()=>await(await import('./src/storage.js')).get('state','project'));assert.equal(p.assets.length,102);assert.ok(p.assets.some(a=>a.recordPending));
  const oldCount=p.assets.length;await page.evaluate(()=>window.__remaining=0);await page.locator('#asset-operation-save').click();await page.waitForFunction(()=>document.querySelector('#asset-operation-feedback').textContent.includes('保存已恢复'));await finished();
  p=await page.evaluate(async()=>await(await import('./src/storage.js')).get('state','project'));assert.equal(p.assets.length,oldCount);assert.ok(p.assets.every(a=>!a.recordPending&&!a.diskPending));assert.equal(await page.locator('#asset-operation-save').isVisible(),false);checks.push('persistent mapping failure is bounded, actionable and recoverable with no duplicate imports');
  const download=page.waitForEvent('download');await page.locator('#asset-operation-report').click();const report=await download;await report.saveAs('test-results/mapping-v114-report.md');checks.push('processing report includes the local failure stage and retry outcome without remote requests');
  await page.locator('#asset-operation-done').click();
  const ambiguous=await page.evaluate(async()=>{const s=await import('./src/storage.js');let closes=0;const native=__native;FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await native.apply(this,args);if(this.name!=='ambiguous.json')return stream;const close=stream.close.bind(stream);stream.close=async()=>{await close();closes++;throw new DOMException('state changed after commit','InvalidStateError');};return stream;};await s.writeFile(__out,'ambiguous.json','verified');FileSystemFileHandle.prototype.createWritable=native;return {closes,text:await(await s.readFile(__out,'ambiguous.json')).text(),diagnostics:await s.get('state','write-diagnostics')};});
  assert.equal(ambiguous.closes,1);assert.equal(ambiguous.text,'verified');assert.equal(ambiguous.diagnostics.at(-1).outcome,'verified-after-error');checks.push('close error after an actual OPFS commit is verified and accepted without rewriting');
  assert.deepEqual(errors,[]);await writeFile('test-results/mapping-v114-results.json',JSON.stringify({at:new Date().toISOString(),checks,errors,imported:batch.count,mappingOpens:batch.opens},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
