// Build the offline reader from the design Markdown. Not used by the app.
// Install marked as a development tool, or set MARKED_PATH to an existing module.
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
let modulePath;
try{modulePath=require.resolve('marked');}catch{
  if(!process.env.MARKED_PATH)throw Error('Rebuilding the reader requires marked. Install it locally or set MARKED_PATH; the generated HTML needs no dependencies.');
  modulePath=process.env.MARKED_PATH;
}
const {Marked,Renderer}=await import(pathToFileURL(modulePath).href);
const source=new URL('../docs/X-AI详细设计文档.md',import.meta.url);
const destination=new URL('../docs/X-AI详细设计文档.html',import.meta.url);
const markdown=await readFile(source,'utf8');
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const baseline=markdown.match(/文档基准日期：(\d{4}-\d{2}-\d{2})/)?.[1]||'未注明';
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const renderer=new Renderer(),toc=[];
let headingIndex=0;
renderer.heading=function(token){
  const id='section-'+(++headingIndex),text=this.parser.parseInline(token.tokens);
  if(token.depth===2||token.depth===3)toc.push({id,depth:token.depth,title:token.text.replace(/[`*]/g,'')});
  return `<h${token.depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="链接到本节">#</a></h${token.depth}>\n`;
};
const box=(title,body='')=>`<div class="flow-box"><strong>${title}</strong>${body?'<span>'+body+'</span>':''}</div>`;
renderer.code=function(token){
  const lang=(token.lang||'text').split(' ')[0];
  const raw=`<pre><code>${escape(token.text)}</code></pre>`;
  if(lang!=='mermaid')return `<div class="code-block"><div class="code-label">${escape(lang)}</div>${raw}</div>\n`;
  let diagram;
  if(token.text.includes('重新打开'))diagram=`<div class="diagram-title">恢复过程</div><div class="flow-row">${box('打开页面','取得同源独占锁')}<b class="arrow">→</b>${box('读取与恢复','核验项目、媒体、权限')}<b class="arrow">→</b>${box('检查原任务','优先保留 video_id')}</div><div class="flow-branches">${box('已有 video_id','继续原任务查询 / 下载')}${box('提交过但缺 ID','人工核实 → 绑定原编号或记录未创建依据')}${box('从未提交','输入复核后进入待提交')}</div>`;
  else if(token.text.includes('stateDiagram'))diagram=`<div class="diagram-title">主要状态流转</div><div class="flow-row">${box('待提交','输入格式通过')}<b class="arrow">→</b>${box('提交中','检查点先落盘')}<b class="arrow">→</b>${box('排队 / 生成','查询同一 video_id')}</div><div class="flow-row">${box('下载 / 校验','保留 raw、SHA、QA')}<b class="arrow">→</b>${box('技术通过','待内容审核')}<b class="arrow">→</b>${box('人工通过','整集仍待复核')}</div><div class="flow-branches">${box('提交不明','暂停并核实，不盲重发')}${box('明确拒绝创建','退避，或修正输入 / 认证')}${box('内容不合格','记录原因；用户修订后再启动')}</div>`;
  else diagram=`<div class="diagram-title">组件与数据流</div><div class="flow-row">${box('界面','HTML · CSS · app.js')}<b class="arrow">→</b>${box('业务模块','清单 · 素材 · 密钥 · 队列')}<b class="arrow">→</b>${box('生成服务','AgnesAI · HTTPS 媒体')}</div><div class="flow-branches">${box('输入解析','batch / references<br>路径、类型、引用链、哈希')}${box('本地数据','storage / IndexedDB<br>授权目录、版本、历史、过程记录')}${box('媒体处理','media / FFmpeg WASM<br>抽帧、解码、优化、拼接')}</div>`;
  return `<figure class="diagram" aria-label="流程图">${diagram}<details><summary>查看 Mermaid 源码，供开发复用</summary>${raw}</details></figure>\n`;
};
renderer.table=function(token){return `<div class="table-scroll">${Renderer.prototype.table.call(this,token)}</div>\n`;};
const parser=new Marked({renderer,gfm:true,async:false});
const body=parser.parse(markdown);
const nav=toc.map(x=>`<a class="level-${x.depth}" href="#${x.id}">${escape(x.title)}</a>`).join('\n');
const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="X-AI ${escape(version)}详细设计：产品、界面、架构、数据、文件、递归引用、队列、校验、恢复、部署与开发交接。">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>X-AI ${escape(version)} · 详细设计文档</title>
<style>
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;color:#262c3c;background:#f5f4f8;font:16px/1.85 'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif}
a{color:#5d47a8;text-underline-offset:3px}a:hover{color:#38257a}.reader-nav{position:fixed;inset:0 auto 0 0;width:310px;overflow:auto;padding:28px 23px;background:#f9f7fd;border-right:1px solid #e0d9ef}.reader-brand{font-size:25px;font-weight:800;letter-spacing:1px;color:#2c2546}.reader-brand small{font-size:15px;font-weight:500;display:block;letter-spacing:0;color:#746686;margin-top:4px}.reader-meta{margin:16px 0 20px;font-size:14px;line-height:1.75;color:#6b607a}.reader-nav nav{display:grid;gap:5px}.reader-nav nav a{display:block;text-decoration:none;font-size:14px;line-height:1.6;padding:6px 8px;border-radius:6px}.reader-nav nav a:hover{background:#eae3f7}.reader-nav .level-2{font-weight:650;border-top:1px solid #ebe5f2;padding-top:12px;margin-top:4px}.reader-nav .level-3{padding-left:20px;color:#6b607a}
.document{margin-left:310px;padding:42px 48px 64px;max-width:1480px}.paper{max-width:1030px;background:white;border:1px solid #e6e0ed;border-radius:14px;padding:38px 42px;box-shadow:0 8px 32px #39246c08}.document-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 18px;font-size:14px;color:#746982}.document-bar a{padding:6px 12px;border:1px solid #d9cee9;border-radius:6px;text-decoration:none;background:#fff}h1,h2,h3{color:#292239;line-height:1.45;scroll-margin-top:22px}h1{font-size:34px;margin:0 0 24px;letter-spacing:-.5px}h2{font-size:25px;margin:50px 0 20px;padding-top:22px;border-top:1px solid #e8e1ef}h3{font-size:20px;margin:30px 0 12px}p{margin:12px 0 18px}li{margin:6px 0}strong{font-weight:650}blockquote{margin:20px 0;padding:15px 20px;background:#f5f1fc;border-left:4px solid #8c72ba;border-radius:0 8px 8px 0;color:#5a4a6e}blockquote p{margin:0}
.anchor{margin-left:9px;font-size:.72em;color:#c1b2d1;text-decoration:none}h2:hover .anchor,h3:hover .anchor{color:#856aaa}code{font-family:Consolas,'Cascadia Code',monospace;font-size:.9em;background:#f2eef7;color:#503d72;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{margin:0;overflow:auto;padding:17px 20px;line-height:1.65;background:#1e2231;color:#eef0f8;tab-size:2}pre code{background:none;color:inherit;padding:0;font-size:14px;white-space:pre;overflow-wrap:normal}.code-block{margin:18px 0 22px;border:1px solid #ddd5e9;border-radius:8px;overflow:hidden}.code-label{font-size:12px;letter-spacing:.6px;text-transform:uppercase;background:#ece6f4;color:#67547e;padding:5px 14px}
.table-scroll{overflow:auto;border:1px solid #e4ddeb;border-radius:8px;margin:18px 0 24px}table{border-collapse:collapse;width:100%;min-width:550px;font-size:14px;line-height:1.75}th{background:#f0eaf8;color:#4d3e63;text-align:left}th,td{padding:11px 13px;border-bottom:1px solid #e9e3ef;vertical-align:top}tbody tr:nth-child(even){background:#fcfbfe}tr:last-child td{border-bottom:0}td code{white-space:normal}
.diagram{margin:22px 0;padding:22px;background:#f7f4fc;border:1px solid #ddd2ed;border-radius:10px}.diagram-title{font-size:16px;font-weight:650;color:#594277;margin-bottom:14px}.flow-row{display:flex;gap:10px;align-items:center;margin-bottom:12px}.flow-box{background:white;border:1px solid #d9ccea;border-radius:8px;padding:13px;flex:1;min-width:0;font-size:14px}.flow-box strong{display:block;color:#553c77}.flow-box span{display:block;color:#6c6375;line-height:1.65;margin-top:4px}.arrow{color:#9680b4;font-size:20px}.flow-branches{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.diagram details{margin-top:15px;font-size:14px}.diagram summary{cursor:pointer;color:#6a547f}.diagram details pre{margin-top:10px;border-radius:6px}.reader-footer{margin-top:40px;padding-top:18px;border-top:1px solid #e5dded;font-size:14px;color:#71657e}
@media(max-width:1100px){.reader-nav{width:265px;padding:22px 15px}.document{margin-left:265px;padding:25px}.paper{padding:28px}}
@media(max-width:760px){.reader-nav{position:static;width:auto;max-height:280px;border-right:0;border-bottom:1px solid #ded5eb;padding:20px}.reader-nav .reader-brand{font-size:22px}.reader-meta{margin:8px 0 12px}.reader-nav nav{display:grid;grid-template-columns:1fr}.reader-nav .level-3{display:none}.document{margin:0;padding:15px}.paper{padding:24px 18px;border-radius:9px}h1{font-size:28px}h2{font-size:23px}h3{font-size:19px}.flow-row{flex-direction:column}.flow-box{width:100%}.arrow{transform:rotate(90deg)}.flow-branches{grid-template-columns:1fr}.table-scroll{max-width:100%}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{body{background:white;font-size:11pt;color:#111}.reader-nav,.document-bar,.anchor{display:none}.document{margin:0;padding:0;max-width:none}.paper{border:0;padding:0;max-width:none;box-shadow:none}h1{font-size:24pt}h2{break-before:auto;font-size:17pt}h3{font-size:13pt}h1,h2,h3{break-after:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f2f2;color:#222}pre code{white-space:pre-wrap;color:#222}.table-scroll{overflow:visible;border:0}table{min-width:0;font-size:9pt}tr{break-inside:avoid}.diagram{break-inside:avoid}details{display:none}a{color:inherit}}
</style></head><body>
<aside class="reader-nav"><div class="reader-brand">X-AI <small>详细设计文档 · ${escape(version)}</small></div><p class="reader-meta">基准：${escape(baseline)} · 北京时间<br>实现、验证与扩展分别说明<br>正文约 ${markdown.length.toLocaleString('zh-CN')} 字符 · ${toc.filter(x=>x.depth===2).length} 章</p><nav aria-label="文档目录">${nav}</nav></aside>
<main class="document"><div class="document-bar"><span>可直接双击阅读 · 无脚本 / 无联网依赖</span><a href="./X-AI详细设计文档.md" download>下载 Markdown 源文档</a><a href="../README.md">项目使用说明</a><span>可用浏览器 Ctrl+P 打印</span></div><article class="paper">${body}<footer class="reader-footer">本文由同目录 Markdown 生成。以当前源码和用户最新要求核对；未实现功能与未执行检查不得冒充完成。® YiQiXP</footer></article></main>
</body></html>`;
await writeFile(destination,html,'utf8');
console.log(JSON.stringify({source:fileURLToPath(source),html:fileURLToPath(destination),characters:markdown.length,chapters:toc.filter(x=>x.depth===2).length,sections:toc.filter(x=>x.depth===3).length}));
