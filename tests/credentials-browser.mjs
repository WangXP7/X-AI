import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {encryptKey} from '../src/core.js';
import {sealLocalDefault} from '../src/local-default.js';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(process.env.PLAYWRIGHT_PATH));}
const browser=await chromium.launch({channel:'msedge',headless:true});
const out=new URL('../test-results/',import.meta.url);await mkdir(out,{recursive:true});
const key='sk-synthetic-credential-test-not-a-live-key',customKey='sk-custom-synthetic-not-a-live-key';
const password='synthetic local password',vault=await encryptKey(key,password),envelope=await sealLocalDefault(key);
const checks=[],errors=[],metrics=[];let apiCalls=0;const base=process.env.XAI_TEST_URL||'http://127.0.0.1:4173/';
const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
await context.route('**/private/default-access.json',route=>route.fulfill({json:envelope}));
await context.route('**/private/default-vault.json',route=>route.fulfill({json:vault}));
await context.route('https://api.agnes-ai.cn/**',route=>{
  assert.equal(route.request().url(),'https://api.agnes-ai.cn/v1/models');
  assert.equal(route.request().headers().authorization,'Bearer '+customKey);
  apiCalls++;return route.fulfill({json:{data:[{id:'agnes-video-2.5-flash'}]}});
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
async function waitFeedback(text){await page.waitForFunction(text=>document.querySelector('#settings-feedback').textContent.includes(text),text);await page.waitForFunction(()=>document.querySelector('#settings-dialog').getAttribute('aria-busy')==='false');}
async function onTop(selector){return page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});}
async function storedVault(){return page.evaluate(async()=>{const {get}=await import('./src/storage.js');return get('state','vault');});}
try{
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('系统默认密钥已启用'));
  assert.equal(apiCalls,0);assert.equal(await storedVault(),undefined);
  checks.push('default key activates on page load with no password or authenticated request');await page.locator('#experience-expert').click();await page.locator('#mode-single').click();
  for(const viewport of [{width:2238,height:1196},{width:1280,height:900}]){
    await page.setViewportSize(viewport);await page.evaluate(()=>scrollTo(0,0));
    const measured=await page.evaluate(()=>{const rect=selector=>document.querySelector(selector).getBoundingClientRect();return {width:innerWidth,composerTop:rect('.composer').top,addButtonBottom:rect('#add-jobs').bottom,directoryButtonGap:rect('#choose-folder').left-rect('.directory-copy').right,overflow:document.documentElement.scrollWidth>innerWidth,fonts:Object.fromEntries(['.page-footer','#connection-status','.local-card p','.form-footer'].map(selector=>[selector,parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)]))};});
    // Expert mode now includes the project/directory management bars above a scrollable form.
    assert.ok(measured.composerTop<300,JSON.stringify(measured));assert.ok(measured.directoryButtonGap<20);assert.equal(measured.overflow,false);assert.ok(Object.values(measured.fonts).every(size=>size>=13));metrics.push(measured);
    await page.screenshot({path:fileURLToPath(new URL('compact-studio-'+viewport.width+'.png',out)),fullPage:true});
  }
  checks.push('2238px and 1280px expert layouts keep the project bars, readable supporting text and folder button alignment without horizontal overflow');
  await page.locator('#settings-button').click();await page.waitForFunction(()=>document.querySelector('#stored-key-title').textContent.includes('已找到'));
  assert.equal(await page.locator('#advanced-mode').getAttribute('open'),null);assert.equal(await page.locator('#vault-password').isVisible(),false);assert.equal(await page.locator('#new-vault-password').isVisible(),false);
  assert.equal(await page.locator('#use-default-key').textContent(),'正在使用');assert.ok(await page.locator('#basic-api-key').isVisible());
  await page.screenshot({path:fileURLToPath(new URL('settings-simple.png',out)),fullPage:true});
  checks.push('normal settings expose default and custom keys while password and backup controls remain collapsed');
  await page.locator('#apply-basic-key').click();await waitFeedback('请填写以 sk-');assert.ok(await onTop('#settings-feedback'));assert.equal(await page.locator('#basic-api-key').getAttribute('aria-invalid'),'true');assert.equal(await page.locator('#toast-region .toast').count(),0);
  await page.locator('#basic-api-key').fill(customKey);await page.locator('#apply-basic-key').click();await waitFeedback('新密钥已启用');assert.equal(await page.locator('#basic-api-key').inputValue(),'');assert.equal(await storedVault(),undefined);
  await page.locator('#test-connection').click();await waitFeedback('连接成功');assert.equal(apiCalls,1);
  checks.push('one-field custom key works, invalid input stays visibly inside the dialog and a mocked authenticated request uses the new key');
  await page.locator('#use-default-key').click();await waitFeedback('已切换为系统默认密钥');assert.ok((await page.locator('#connection-status').textContent()).includes('系统默认密钥'));
  await page.locator('#advanced-mode>summary').click();await page.locator('#unlock-key').click();await waitFeedback('请粘贴解锁口令');assert.ok(await onTop('#settings-feedback'));assert.equal(await storedVault(),undefined);
  await page.locator('#vault-password').fill('wrong password');await page.locator('#unlock-key').click();await waitFeedback('口令不正确');assert.ok(await onTop('#settings-feedback'));assert.equal(await storedVault(),undefined);assert.ok((await page.locator('#connection-status').textContent()).includes('系统默认密钥'));
  await page.screenshot({path:fileURLToPath(new URL('settings-error-desktop.png',out)),fullPage:true});
  checks.push('advanced empty/wrong password errors remain above the modal backdrop and do not replace an active default key');
  await page.locator('#vault-password').fill(password);await page.locator('#unlock-key').click();await waitFeedback('解锁成功');assert.equal(await page.locator('#vault-password').inputValue(),'');
  let stored=await storedVault();assert.equal(stored.cipher,vault.cipher);assert.equal(JSON.stringify(stored).includes(key),false);assert.equal(JSON.stringify(stored).includes(password),false);
  await page.locator('#new-key-tab').click();await page.locator('#api-key').fill(customKey);await page.locator('#new-vault-password').fill('new synthetic password');await page.locator('#confirm-vault-password').fill('different password');await page.locator('#save-key').click();await waitFeedback('两次解锁口令不一致');assert.equal((await storedVault()).cipher,vault.cipher);
  await page.locator('#confirm-vault-password').fill('new synthetic password');await page.locator('#save-key').click();await waitFeedback('已加密保存并启用');const replacement=await storedVault();assert.notEqual(replacement.cipher,vault.cipher);assert.equal(await page.locator('#api-key').inputValue(),'');
  checks.push('advanced encrypted save still validates password confirmation and persists only ciphertext');
  await page.locator('#remember-key').uncheck();await page.locator('#api-key').fill(key);await page.locator('#save-key').click();await waitFeedback('仅本次会话有效');assert.equal((await storedVault()).cipher,replacement.cipher);
  await page.locator('.key-management summary').click();await page.locator('#vault-import').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"format":"wrong"}')});await waitFeedback('不是有效');assert.equal((await storedVault()).cipher,replacement.cipher);
  await page.locator('#vault-import').setInputFiles({name:'encrypted.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(vault))});await waitFeedback('已读取文件');assert.equal((await storedVault()).cipher,replacement.cipher);
  checks.push('advanced session-only input and unverified imports do not overwrite existing encrypted backups');
  await page.locator('#vault-password').fill('wrong again');await page.locator('#unlock-key').click();await waitFeedback('口令不正确');
  await page.setViewportSize({width:390,height:844});assert.ok(await onTop('#settings-feedback'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:fileURLToPath(new URL('settings-error-mobile.png',out)),fullPage:true});
  await page.locator('#advanced-mode>summary').click();assert.ok(await onTop('#settings-feedback'));
  await page.locator('#done-settings').click();await page.locator('#settings-button').click();assert.equal(await page.locator('#advanced-mode').getAttribute('open'),null);assert.equal(await page.locator('#basic-api-key').inputValue(),'');
  await page.screenshot({path:fileURLToPath(new URL('settings-simple-mobile.png',out)),fullPage:true});
  await page.locator('#done-settings').click();await page.reload();await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('系统默认密钥已启用'));
  checks.push('mobile errors stay visible even when advanced mode closes; reopening resets advanced UI and refresh restores the default key');
  await page.setViewportSize({width:1280,height:900});await page.locator('#prompt-example').click();await page.locator('#generation-mode').selectOption('text');await page.locator('#add-jobs').click();await page.locator('[data-view=studio]').click();assert.equal(await page.locator('#workspace-pending').textContent(),'1');assert.equal(await page.locator('#workspace-ready').textContent(),'0 / 1');await page.locator('[data-view=queue]').click();
  await page.locator('[data-detail]').click();await page.locator('[data-edit-job]').click();await page.locator('#revision-editor').waitFor();assert.equal(await page.locator('#revision-editor').isVisible(),true);await page.locator('#experience-expert').click();await page.locator('#generation-mode').selectOption('reference');await page.locator('#add-jobs').click();
  await page.locator('#toast-region .toast.error').last().waitFor();assert.ok((await page.locator('#toast-region .toast.error').last().textContent()).includes('至少需要'));assert.equal(await page.locator('#revision-editor').isVisible(),true);await page.locator('#cancel-revision').click();
  checks.push('workspace counts update with tasks; revision errors preserve original editor for correction');
  for(const [label,response] of [['public',{status:404,body:'missing'}],['damaged',{json:{...envelope,cipher:'broken'}}]]){
    const ctx=await browser.newContext();const p=await ctx.newPage();await ctx.route('**/private/default-access.json',r=>r.fulfill(response));await ctx.route('**/private/default-vault.json',r=>r.fulfill({status:404,body:'missing'}));
    await p.goto(base);await p.locator('#settings-button').click();await p.waitForFunction(()=>document.querySelector('#stored-key-title').textContent==='还没有已存密钥');assert.ok(await p.locator('#basic-api-key').isVisible());assert.equal(await p.locator('#test-connection').isDisabled(),true);assert.equal(await p.locator('#advanced-mode').getAttribute('open'),null);
    if(label==='damaged'){await p.locator('#use-default-key').click();await p.waitForFunction(()=>document.querySelector('#settings-feedback').textContent.includes('暂时无法读取'));}
    await ctx.close();
  }
  checks.push('public and damaged-default builds still open the simple custom-key flow without a password requirement');
  assert.deepEqual(errors,[]);
  const report={at:new Date().toISOString(),checks,metrics,apiCalls,pageErrors:errors};await writeFile(new URL('credentials-results.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
