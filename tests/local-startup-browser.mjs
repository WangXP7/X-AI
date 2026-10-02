// Local page and offline documentation checks; no real key or generation request.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const base=process.env.XAI_TEST_URL||'http://127.0.0.1:4183/';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[],unexpected=[];
  const config=await sealLocalDefault('sk-synthetic-startup-not-a-real-key');
  await context.route('**/private/default-access.json',route=>route.fulfill({json:config}));
  await context.route('https://**',route=>{unexpected.push(route.request().url());return route.abort();});
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  const response=await page.goto(base);assert.equal(response.status(),200);
  await page.waitForFunction(()=>document.documentElement.dataset.ready==='true');
  assert.ok((await page.locator('.version').textContent()).includes('X-AI '+version));
  assert.equal((await context.request.get(new URL('src/studio.js',base).href)).status(),200);
  const identity=await(await context.request.get(new URL('__xai_health',base).href)).json();
  assert.equal(identity.app,'x-ai-video-studio');assert.equal(identity.version,version);
  assert.equal(await page.locator('#single-editor').isVisible(),true);
  assert.equal(await page.locator('#batch-editor').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'test-results/startup-v112-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'test-results/startup-v112-mobile.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  const doc=await browser.newPage({viewport:{width:1440,height:1000}}),docErrors=[],docRequests=[];
  doc.on('pageerror',error=>docErrors.push(error.message));
  doc.on('request',request=>{if(!request.url().startsWith('file:'))docRequests.push(request.url());});
  await doc.goto(new URL('../docs/X-AI详细设计文档.html',import.meta.url).href);
  const reading=await doc.evaluate(()=>({title:document.title,chapters:document.querySelectorAll('h2').length,
    sections:document.querySelectorAll('h3').length,scripts:document.scripts.length,
    missing:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.hash.slice(1))).length,
    overflow:document.documentElement.scrollWidth>innerWidth}));
  assert.ok(reading.title.includes(version));assert.equal(reading.chapters,35);
  assert.equal(reading.missing,0);assert.equal(reading.scripts,0);assert.equal(reading.overflow,false);
  await doc.locator('.reader-nav a.level-2').last().click();
  await doc.locator('h2').last().evaluate(element=>element.scrollIntoView({behavior:'instant',block:'start'}));
  await doc.screenshot({path:'test-results/design-v113-source-section.png'});
  await doc.setViewportSize({width:390,height:844});
  assert.equal(await doc.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await doc.screenshot({path:'test-results/design-v113-mobile.png'});
  assert.deepEqual(docErrors,[]);assert.deepEqual(docRequests,[]);
  const result={at:new Date().toISOString(),version,url:base,serverPid:identity.pid,
    app:{ready:true,desktopOverflow:false,mobileOverflow:false,errors,externalRequests:unexpected},
    document:{...reading,mobileOverflow:false,errors:docErrors,externalRequests:docRequests}};
  await writeFile('test-results/startup-v120-results.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
