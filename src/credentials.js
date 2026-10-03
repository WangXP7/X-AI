import {encryptKey,decryptKey,friendlyError} from './core.js';
import {get,put,remove,downloadFile} from './storage.js';
import {openLocalDefault} from './local-default.js';

const $=selector=>document.querySelector(selector);
const keyPattern=/^sk-[A-Za-z0-9_-]{12,}$/;
function checkVault(value){
  if(value?.format!=='x-ai-vault-v1'||value.kdf!=='PBKDF2-SHA256'||
    !Number.isInteger(value.iterations)||value.iterations<100000||value.iterations>1000000||
    typeof value.cipher!=='string'||value.cipher.length>20000||
    typeof value.salt!=='string'||typeof value.iv!=='string')throw Error('这不是有效的 X-AI 加密密钥文件，请重新选择。');
  return value;
}

export class CredentialsPanel {
  constructor({transport,bind,onConnectionChange,event,save}){
    Object.assign(this,{transport,onConnectionChange,event,save});
    this.sources={};this.selected='';this.busy=false;this.verified=false;this.tab='saved';this.openSequence=0;this.activeLabel='';this.defaultKey='';this.defaultState='loading';this.kind='';
    bind('#basic-key-form','submit',e=>{e.preventDefault();return this.action(async()=>{
      const key=$('#basic-api-key').value.trim();
      if(!keyPattern.test(key))this.invalid('#basic-api-key','请填写以 sk- 开头的有效 API 密钥。');
      this.transport.key=key;this.kind='custom';this.activeLabel='自定义密钥';this.verified=false;this.clearInputs();
      this.feedback('新密钥已启用，本次打开有效。可点击“检查连接”。','success');
    });});
    bind('#use-default-key','click',()=>this.action(async()=>{
      if(!this.defaultKey)await this.loadDefault();
      if(!this.defaultKey)throw Error(this.defaultState==='missing'?'此版本未配置默认密钥，请填写自己的 API 密钥。':'默认密钥暂时无法读取，请重试或填写自己的密钥。');
      this.activateDefault();this.clearInputs();this.feedback('已切换为系统默认密钥。','success');
    }));
    bind('#toggle-basic-key','click',()=>this.toggleInput('#basic-api-key','#toggle-basic-key'));
    bind('#saved-key-tab','click',()=>this.switchTab('saved'));
    bind('#new-key-tab','click',()=>this.switchTab('new'));
    bind('#saved-key-source','change',()=>{this.selected=$('#saved-key-source').value;$('#vault-password').value='';this.clearFeedback();if(this.transport.key)this.feedback('已选择另一份加密文件，解锁成功后才会替换当前会话的密钥。');this.render();});
    bind('#remember-key','change',()=>this.render());
    bind('#unlock-form','submit',e=>{e.preventDefault();return this.action(()=>this.unlock());});
    bind('#new-key-form','submit',e=>{e.preventDefault();return this.action(()=>this.useNew());});
    bind('#lock-key','click',()=>this.action(async()=>{this.transport.key='';this.verified=false;this.clearInputs();this.kind='';this.feedback('当前密钥已停用。可重新使用默认密钥、填写新密钥，或解锁加密备份。');}));
    bind('#forget-key','click',()=>this.action(async()=>{
      if(!confirm('删除此浏览器保存的加密副本？本机预存文件、项目和视频都会保留。'))return;
      await remove('state','vault');delete this.sources.browser;this.transport.key='';this.verified=false;this.selected=this.sources.local?'local':'';
      this.feedback('已删除浏览器中的加密副本。本机预存文件仍保留。');
    }));
    bind('#vault-import','change',e=>{const file=e.target.files[0];e.target.value='';if(!file)return;return this.action(async()=>{
      if(file.size>20000)throw Error('文件太大，请选择 X-AI 导出的加密密钥 JSON。');
      let value;try{value=JSON.parse(await file.text());}catch{throw Error('文件不是有效的 JSON，请选择 X-AI 导出的加密密钥文件。');}
      this.sources.imported={vault:checkVault(value),label:'刚导入的加密密钥文件'};this.selected='imported';$('#vault-password').value='';this.switchTab('saved');
      this.feedback('已读取文件。输入这份文件对应的解锁口令，成功后才会保存到浏览器。');
    });});
    bind('#export-vault','click',()=>this.action(async()=>{const vault=await get('state','vault');if(!vault)throw Error('此浏览器还没有保存加密密钥。');downloadFile('X-AI_加密密钥备份.json',JSON.stringify(vault,null,2));this.feedback('已导出加密密钥备份。解锁口令需要另外记住。');}));
    bind('#test-connection','click',()=>this.action(async()=>{
      if(!this.transport.key)throw Error('请先启用默认密钥或填写新密钥，再检查连接。');
      this.feedback('正在检查连接，请稍候。此操作不占生成提交间隔，也不会创建视频。','pending');
      try{await this.transport.api('/v1/models');}
      catch(e){this.verified=false;throw Error(friendlyError(e)+' 可展开“高级模式 → 高级连接设置”调整调用方式。');}
      this.verified=true;this.event('connection_check','模型列表API认证成功');await this.save();this.feedback('连接成功，可以开始生成。该检查没有创建视频。','success');
    }));
    bind('#done-settings','click',()=>$('#settings-dialog').close());
    bind('#toggle-api-key','click',()=>{const input=$('#api-key'),visible=input.type==='password';input.type=visible?'text':'password';$('#toggle-api-key').textContent=visible?'隐藏':'显示';$('#toggle-api-key').setAttribute('aria-pressed',String(visible));});
    $('#settings-dialog').addEventListener('close',()=>{this.openSequence++;this.clearInputs();});
  }

  toggleInput(inputId,buttonId){const input=$(inputId),visible=input.type==='password';input.type=visible?'text':'password';$(buttonId).textContent=visible?'隐藏':'显示';$(buttonId).setAttribute('aria-pressed',String(visible));}
  async initialize(){
    await this.loadDefault();if(this.defaultKey)this.activateDefault();
    this.render();this.onConnectionChange({credentialChanged:!!this.transport.key});
  }
  async loadDefault(){
    this.defaultState='loading';
    try{
      const response=await fetch('./private/default-access.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(response.status===404){this.defaultState='missing';return;}
      if(!response.ok)throw Error();
      this.defaultKey=await openLocalDefault(await response.json());this.defaultState='ready';
    }catch{this.defaultState='error';}
  }
  activateDefault(){this.transport.key=this.defaultKey;this.kind='default';this.activeLabel='系统默认密钥';this.verified=false;}

  async open(){
    const seq=++this.openSequence;$('#advanced-mode').open=false;$('#toast-region').replaceChildren();this.clearFeedback();this.clearInputs();this.sources={};this.selected='';this.detecting=true;
    const existing=await get('state','vault');
    if(existing){try{this.sources.browser={vault:checkVault(existing),label:'此浏览器已保存的密钥'};this.selected='browser';}catch{this.feedback('浏览器保存的密钥文件无法读取。可导入备份或输入新密钥。','error');}}
    this.switchTab('saved');if(!$('#settings-dialog').open)$('#settings-dialog').showModal();this.render();
    try{
      const response=await fetch('./private/default-vault.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(seq!==this.openSequence)return;
      if(response.ok){
        const vault=checkVault(await response.json());
        if(seq!==this.openSequence)return;
        this.sources.local={vault,label:'本机预存密钥（已找到）'};
        if(!this.selected)this.selected='local';
      }else if(response.status!==404){this.feedback('暂时无法读取本机预存文件。可以重开设置再试，或导入加密密钥文件。','error');}
    }catch(e){if(seq===this.openSequence)this.feedback('未能读取本机预存文件。可以导入加密文件，或输入自己的密钥。','error');}
    if(seq!==this.openSequence)return;
    this.detecting=false;if(!this.selected)this.switchTab('new');this.render();
  }

  async action(fn){
    if(this.busy)return;
    const previousKey=this.transport.key;
    // Session credentials are independent of editing production records. A
    // downloading/waiting job must not prevent enabling the key it may need.
    try{this.busy=true;this.clearFeedback();this.render();await fn();}
    catch(e){this.feedback(friendlyError(e),'error');}
    finally{this.busy=false;this.render();if(this.focusAfterError){$(this.focusAfterError).focus();this.focusAfterError=null;}this.onConnectionChange({credentialChanged:previousKey!==this.transport.key});}
  }
  feedback(message,kind='info'){
    const target=$('#settings-feedback');target.hidden=false;target.className='settings-feedback '+kind;
    target.textContent=message;target.setAttribute('role',kind==='error'?'alert':'status');
  }
  clearFeedback(){const el=$('#settings-feedback');el.hidden=true;el.textContent='';for(const input of document.querySelectorAll('#settings-dialog [aria-invalid]'))input.removeAttribute('aria-invalid');}
  invalid(selector,message){$(selector).setAttribute('aria-invalid','true');this.focusAfterError=selector;throw Error(message);}
  clearInputs(){for(const id of ['#basic-api-key','#api-key','#vault-password','#new-vault-password','#confirm-vault-password'])$(id).value='';$('#basic-api-key').type='password';$('#toggle-basic-key').textContent='显示';$('#toggle-basic-key').setAttribute('aria-pressed','false');$('#api-key').type='password';$('#toggle-api-key').textContent='显示';$('#toggle-api-key').setAttribute('aria-pressed','false');}
  switchTab(name){this.tab=name;$('#saved-key-pane').hidden=name!=='saved';$('#new-key-pane').hidden=name!=='new';for(const [id,value] of [['saved-key-tab','saved'],['new-key-tab','new']]){const button=$('#'+id);button.classList.toggle('selected',name===value);button.setAttribute('aria-selected',String(name===value));}this.render();}

  render(){
    const hasKey=!!this.transport.key,available=Object.keys(this.sources),source=this.sources[this.selected];
    const sameAsLocal=source&&this.sources.local&&source.vault.cipher===this.sources.local.vault.cipher;
    const select=$('#saved-key-source');select.replaceChildren(...available.map(id=>new Option(this.sources[id].label,id)));select.value=this.selected;
    $('#saved-source-choice').hidden=available.length<2;$('#saved-key-empty').hidden=!!source||this.detecting;
    $('#unlock-form').hidden=!source;$('#local-password-help').hidden=!sameAsLocal;
    $('#custom-password-help').hidden=!!sameAsLocal;
    $('#stored-key-title').textContent=this.detecting&&!source?'正在查找已存密钥…':source?source.label:'还没有已存密钥';
    $('#stored-key-description').textContent=source?'已找到加密文件，无需再填写 API 密钥。':'可导入备份文件，或切换到“输入新密钥”。';
    $('#vault-state-title').textContent=hasKey?(this.verified?'连接已验证':`${this.activeLabel||'当前密钥'}已启用`):'尚未启用密钥';
    $('#vault-state-detail').textContent=hasKey?(this.verified?'已通过 AgnesAI 认证，可以开始生成。':'可直接用于生成；检查连接可验证密钥是否有效。'):'使用默认密钥，或在下方填写自己的密钥。';
    $('#default-key-description').textContent={loading:'正在读取本机配置…',ready:'本机已预置，打开页面自动启用。',missing:'此版本未配置默认密钥，请填写自己的密钥。',error:'读取失败，可重试或填写自己的密钥。'}[this.defaultState];
    $('#use-default-key').textContent=hasKey&&this.kind==='default'?'正在使用':this.defaultState==='error'?'重新读取默认密钥':'使用默认密钥';
    $('#use-default-key').disabled=this.busy||this.defaultState==='loading'||this.defaultState==='missing'||hasKey&&this.kind==='default';
    for(const el of document.querySelectorAll('#basic-key-form input,#basic-key-form button'))el.disabled=this.busy;
    $('#vault-status').classList.toggle('unlocked',hasKey);
    $('#new-password-fields').hidden=!$('#remember-key').checked;
    $('#save-key').textContent=$('#remember-key').checked?'加密保存并使用':'仅在本次会话使用';
    $('#save-key').hidden=this.tab!=='new';$('#save-key').disabled=this.busy;
    $('#unlock-key').hidden=this.tab!=='saved'||!source;
    $('#unlock-key').classList.toggle('primary',!hasKey);$('#unlock-key').classList.toggle('secondary',hasKey);
    $('#test-connection').classList.toggle('primary',hasKey);$('#test-connection').classList.toggle('secondary',!hasKey);
    $('#lock-key').hidden=!hasKey;$('#test-connection').disabled=!hasKey||this.busy;
    $('#connection-next-step').textContent=hasKey?(this.verified?'连接已验证，可以关闭此窗口。':'下一步：检查连接，不会创建视频。'):'启用密钥后可检查连接，不会创建视频。';
    for(const id of ['#export-vault','#forget-key'])$(id).disabled=!this.sources.browser||this.busy;
    for(const el of document.querySelectorAll('#credential-entry input,#credential-entry select,#credential-entry button,#connection-advanced input,#connection-advanced select'))el.disabled=this.busy;
    $('#vault-import').disabled=this.busy;$('#lock-key').disabled=this.busy;$('#unlock-key').disabled=!source||this.busy;$('#settings-dialog').setAttribute('aria-busy',String(this.busy));
  }

  async unlock(){
    const source=this.sources[this.selected];if(!source)throw Error('请先选择一份加密密钥文件。');
    const password=$('#vault-password').value;
    if(!password)this.invalid('#vault-password','请粘贴解锁口令。这里不填 AgnesAI 的 API 密钥。');
    let key;
    try{key=await decryptKey(source.vault,password);}catch{this.invalid('#vault-password','解锁口令不正确，或与当前选中的密钥文件不匹配。请核对口令来源后再试。'+(this.transport.key?' 当前会话仍保留之前已解锁的密钥。':''));}
    if(!keyPattern.test(key))throw Error('解密结果不是有效的 AgnesAI 密钥，请重新导入密钥文件。');
    // Do not replace a previously saved vault until the candidate has decrypted successfully.
    await put('state','vault',source.vault);this.sources.browser={vault:source.vault,label:'此浏览器已保存的密钥'};
    this.transport.key=key;this.kind='advanced';this.activeLabel='加密保存的密钥';this.verified=false;$('#vault-password').value='';
    this.feedback('解锁成功。下一步点击“检查连接”，验证这份密钥是否可用。','success');
  }

  async useNew(){
    const key=$('#api-key').value.trim();if(!keyPattern.test(key))this.invalid('#api-key','请填写有效的 AgnesAI API 密钥（以 sk- 开头）。');
    if($('#remember-key').checked){
      const password=$('#new-vault-password').value;
      if(password.length<12)this.invalid('#new-vault-password','请设置至少 12 位的解锁口令，用于以后打开加密密钥。');
      if(password!==$('#confirm-vault-password').value)this.invalid('#confirm-vault-password','两次解锁口令不一致，请重新确认。');
      const vault=await encryptKey(key,password);await put('state','vault',vault);this.sources.browser={vault,label:'此浏览器已保存的密钥'};this.selected='browser';
    }
    this.transport.key=key;this.kind='advanced';this.activeLabel=$('#remember-key').checked?'新密钥（已加密保存）':'新密钥（未保存）';this.verified=false;this.clearInputs();
    this.feedback($('#remember-key').checked?'密钥已加密保存并启用。请记住自己设置的解锁口令，再点击“检查连接”。':'密钥已启用，仅本次会话有效。浏览器里原有的加密副本未改动。','success');
  }
}
