import {uid,sha256,DIMENSIONS} from './core.js';
import {durationQA} from './prompt-spec.js';
import {storeBlob,blob,readAsset,freshSource} from './storage.js';
import {sourceMetadata} from './asset-source.js';
export function dataURL(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);});}
function metadata(file,type){return new Promise((resolve,reject)=>{const el=document.createElement(type),url=URL.createObjectURL(file);let timer=setTimeout(()=>finish(Error('无法读取媒体信息，请转换为常见格式后导入。')),15000);const finish=(err)=>{clearTimeout(timer);const info={duration:el.duration,width:el.videoWidth,height:el.videoHeight};el.removeAttribute('src');el.load();URL.revokeObjectURL(url);err?reject(err):resolve(info);};el.preload='metadata';el.onloadedmetadata=()=>finish(Number.isFinite(el.duration)&&el.duration>0?null:Error('媒体时长无法识别。'));el.onerror=()=>finish(Error('此浏览器无法解码文件，请转为 MP4/H.264 或 WAV/MP3。'));el.src=url;});}
export async function importAsset(file,extra={},onProgress=()=>{}){
  extra=sourceMetadata(file,extra);
  try{file=await freshSource(file,extra);}catch(e){e.xaiOperation='source-read';throw e;}
  onProgress('检查文件类型与大小');
  const image=/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)||file.type.startsWith('image/');
  const audio=/\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(file.name)||file.type.startsWith('audio/');
  if(!image&&!audio)throw Error(`${file.name}：不支持此素材类型。`);
  if(file.size>150_000_000)throw Error('单个素材超过150MB，请先使用本地编辑器缩小。');
  onProgress('读取原文件，固定本次校验内容');
  try{file=new File([await file.arrayBuffer()],file.name,{type:file.type,lastModified:file.lastModified});}
  catch(e){e.xaiOperation='source-read';throw e;}
  onProgress('计算文件指纹，准备查重');
  if(!file.name||file.name.length>240||/[<>:"/\\|?*\x00-\x1f]/.test(file.name)||/[. ]$/.test(file.name))throw Error('素材文件名无法安全保存，请在原目录修改文件名并同步清单引用后重新导入。');
  const asset={id:uid(),kind:image?'image':'audio',name:file.name,type:file.type,bytes:file.size,sha256:await sha256(file),errors:[],...extra};
  if(file.size>=15_000_000)asset.errors.push('文件须小于15MB，请使用尺寸优化或声音裁切');
  if(image){onProgress('解码图片，检查尺寸与比例');let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw Error(`${file.name}：图片损坏或浏览器不支持。`);}asset.width=bitmap.width;asset.height=bitmap.height;bitmap.close();
    if(!/\.(png|jpe?g|webp)$/i.test(file.name))asset.errors.push('需转换为 PNG / JPEG / WebP');
    if(Math.min(asset.width,asset.height)<256||Math.max(asset.width,asset.height)>5760)asset.errors.push('宽高都必须在256–5760像素内');
    if(asset.width/asset.height<.4||asset.width/asset.height>2.5)asset.errors.push('宽高比须在0.4–2.5之间，可添加边距生成新参考');
  }else{onProgress('读取声音，检查可播放性与时长');const info=await metadata(file,'audio');asset.duration=info.duration;}
  onProgress('保存浏览器本地副本');
  asset.blobKey='asset:'+asset.id;asset.path=extra.storage==='source'?extra.sources[0].path:'references/optimized/'+extra.derivedFrom+'/'+asset.id+'/'+asset.name;await storeBlob(asset.blobKey,file);return asset;
}
export async function optimizeImage(asset,portrait=false){
  if(!/\.(png|jpe?g|webp)$/i.test(asset.name))throw Error('保持同名时无法将此格式转换为 PNG / JPEG / WebP。请用图像工具转换原素材，并同步清单中的文件后缀后重新导入。');
  const original=await readAsset(asset),bitmap=await createImageBitmap(original);let w=bitmap.width,h=bitmap.height;
  if(portrait){w=720;h=1280;}else{const factor=Math.min(1,2048/Math.max(w,h));w=Math.max(256,Math.round(w*factor));h=Math.max(256,Math.round(h*factor));if(w/h>2.5)h=Math.ceil(w/2.5);if(w/h<.4)w=Math.ceil(h*.4);}
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.fillStyle='#ece9e3';ctx.fillRect(0,0,w,h);
  const fit=Math.min(w/bitmap.width,h/bitmap.height);ctx.drawImage(bitmap,(w-bitmap.width*fit)/2,(h-bitmap.height*fit)/2,bitmap.width*fit,bitmap.height*fit);bitmap.close();
  const type=/\.png$/i.test(asset.name)?'image/png':/\.webp$/i.test(asset.name)?'image/webp':'image/jpeg',name=asset.name;
  const file=await new Promise(r=>canvas.toBlob(r,type,.92));if(!file)throw Error('图片转换失败，请缩小原图后再试。');
  if(file.type!==type)throw Error('浏览器无法编码为原文件格式，请使用图像工具生成同名优化版本。');
  const result=await importAsset(new File([file],name,{type}),{derivedFrom:asset.id,transform:portrait?'等比完整置入720×1280画布；同名另存，须复核边距':'等比缩放与补边；保留格式与文件名，原文件保留'});
  result.path='references/optimized/'+asset.id+'/'+result.id+'/'+name;return result;
}
function wav(buffer,start,end){
  const rate=buffer.sampleRate,n=Math.round((end-start)*rate),offset=Math.floor(start*rate),arr=new ArrayBuffer(44+n*2),d=new DataView(arr);const str=(p,s)=>[...s].forEach((c,i)=>d.setUint8(p+i,c.charCodeAt(0)));str(0,'RIFF');d.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,1,true);d.setUint32(24,rate,true);d.setUint32(28,rate*2,true);d.setUint16(32,2,true);d.setUint16(34,16,true);str(36,'data');d.setUint32(40,n*2,true);
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));for(let i=0;i<n;i++){let v=0;for(const c of channels)v+=c[offset+i]||0;v=Math.max(-1,Math.min(1,v/channels.length));d.setInt16(44+i*2,v<0?v*32768:v*32767,true);}return new Blob([arr],{type:'audio/wav'});
}
export async function trimAudio(asset,start,end){
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>asset.duration+.01||end-start>12)throw Error('请选择有效的开始、结束时间，截取长度不能超过12秒。');
  const context=new AudioContext({sampleRate:48000});
  try{
    const buffer=await context.decodeAudioData(await(await readAsset(asset)).arrayBuffer());let result=wav(buffer,start,Math.min(end,buffer.duration)),name=asset.name,type='audio/wav';
    {
      name=asset.name;const ext=name.split('.').at(-1).toLowerCase();
      const codecs={mp3:['libmp3lame','audio/mpeg'],m4a:['aac','audio/mp4'],aac:['aac','audio/aac'],ogg:['libvorbis','audio/ogg'],flac:['flac','audio/flac']};
      if(ext!=='wav'){
        if(!codecs[ext])throw Error('暂不能保留此声音格式进行裁切，请先用音频工具生成同名合规版本。');
        type=codecs[ext][1];const input=result;
        result=await serialFF(async f=>{const src=uid()+'.wav',dst=uid()+'.'+ext;try{await f.writeFile(src,new Uint8Array(await input.arrayBuffer()));const code=await f.exec(['-v','error','-i',src,'-c:a',codecs[ext][0],dst],120000);if(code!==0)throw Error('声音编码失败，请使用音频工具裁切为相同格式后重新导入。');return new Blob([await f.readFile(dst)],{type});}finally{await f.deleteFile(src).catch(()=>{});await f.deleteFile(dst).catch(()=>{});}});
      }
    }
    const output=await importAsset(new File([result],name,{type}),{derivedFrom:asset.id,transform:`截取${start}–${end}秒；同名另存，原文件保留，不补写或伪造对白`});output.path='references/optimized/'+asset.id+'/'+output.id+'/'+name;return output;
  }finally{await context.close();}
}
async function seek(video,t){await new Promise((resolve,reject)=>{if(Math.abs(video.currentTime-t)<.01&&video.readyState>=2)return resolve();const timer=setTimeout(()=>reject(Error('抽帧超时，请使用深度校验。')),12000);video.onseeked=()=>{clearTimeout(timer);resolve();};video.currentTime=t;});}
export async function sampleVideo(file,onProgress=()=>{}){
  const video=document.createElement('video'),url=URL.createObjectURL(file);video.muted=true;video.preload='auto';video.src=url;
  try{await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('视频加载超时。')),15000);video.onloadeddata=()=>{clearTimeout(t);r();};video.onerror=()=>{clearTimeout(t);j(Error('视频无法解码。'));};});const canvas=document.createElement('canvas');canvas.width=240;canvas.height=Math.round(240*video.videoHeight/video.videoWidth);const ctx=canvas.getContext('2d',{willReadFrequently:true}),frames=[],dark=[];
    for(const ratio of [.06,.27,.5,.73,.97]){await seek(video,Math.max(.01,video.duration*ratio));ctx.drawImage(video,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let black=0;for(let i=0;i<pixels.length;i+=4)if((pixels[i]+pixels[i+1]+pixels[i+2])/3<15)black++;dark.push(black/(pixels.length/4));frames.push(await new Promise(r=>canvas.toBlob(r,'image/jpeg',.8)));onProgress({label:`正在抽帧检查 · ${frames.length} / 5`,percent:frames.length/5*100});}
    const last=document.createElement('canvas');last.width=video.videoWidth;last.height=video.videoHeight;await seek(video,Math.max(.01,video.duration-.08));last.getContext('2d').drawImage(video,0,0);return {frames,last:await new Promise(r=>last.toBlob(r,'image/png')),dark};
  }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
let ff,chain=Promise.resolve();
async function engine(){if(ff)return ff;const {FFmpeg}=await import('../vendor/ffmpeg/index.js');const instance=new FFmpeg();await instance.load({coreURL:new URL('../vendor/ffmpeg-core/ffmpeg-core.js',import.meta.url).href,wasmURL:new URL('../vendor/ffmpeg-core/ffmpeg-core.wasm',import.meta.url).href});ff=instance;return ff;}
function serialFF(fn){const p=chain.catch(()=>{}).then(async()=>fn(await engine()));chain=p;return p;}
export async function deepCheck(file,onProgress=()=>{}){onProgress({label:'正在加载本地解码引擎'});return serialFF(async f=>{const input=uid()+'.mp4',logs=[];const log=({message})=>logs.push(message),progress=({progress})=>onProgress({label:'正在完整解码视频',percent:Number.isFinite(progress)?Math.min(99,Math.max(0,progress*100)):null});f.on('log',log);f.on('progress',progress);try{onProgress({label:'正在读取视频并完整解码'});await f.writeFile(input,new Uint8Array(await file.arrayBuffer()));const code=await f.exec(['-hide_banner','-v','info','-xerror','-i',input,'-map','0:v:0','-map','0:a?','-f','null','-'],180000);const joined=logs.join('\n');const fps=Number(joined.match(/,\s*([\d.]+) fps[, ]/)?.[1])||null;return {fullDecode:code===0?'passed':'failed',hasAudio:/Audio:/.test(joined),fps,error:code===0?null:logs.slice(-6).join('\n').slice(0,1500)};}finally{f.off('log',log);f.off('progress',progress);await f.deleteFile(input).catch(()=>{});}});}
export async function inspectVideo(file,job,{deep=true,onProgress=()=>{}}={}){
  const fatal=[],warnings=[],head=new Uint8Array(await file.slice(0,64).arrayBuffer());const sig=new TextDecoder('latin1').decode(head);if(!sig.includes('ftyp'))fatal.push('文件不是有效的MP4容器；请重新下载，不能把错误页面当视频。');
  if(file.size<1024)fatal.push('视频文件过小，可能下载不完整。');
  if(fatal.length)return {fatal,warnings,technical:'failed'};
  const info=await metadata(file,'video'),target=DIMENSIONS[job.aspect];
  const durationCheck=durationQA(info.duration,job.seconds);fatal.push(...durationCheck.fatal);warnings.push(...durationCheck.warnings);
  if(!target||Math.abs(info.width/info.height-target[0]/target[1])>.045)fatal.push(`实际画幅${info.width}×${info.height}不符合${job.aspect}。`);
  if(Math.min(info.width,info.height)<680)fatal.push(`分辨率${info.width}×${info.height}明显低于720P。`);
  onProgress({label:'正在读取时长、画幅与抽帧'});const samples=await sampleVideo(file,onProgress);if(samples.dark.some(v=>v>.9))warnings.push('抽帧有大面积暗画面；可能是夜景或黑帧，请查看后判断。');
  let decode={fullDecode:'not_run'};if(deep){try{decode=await deepCheck(file,onProgress);if(decode.fullDecode==='failed')fatal.push('完整解码未通过，建议先重新下载。');if(!decode.hasAudio)warnings.push('未发现音轨；请检查是否符合本镜要求。');if(decode.fps&&Math.abs(decode.fps-24)>.1)warnings.push(`帧率${decode.fps}fps，拼接时将统一为24fps。`);}catch(e){warnings.push('深度校验暂不可用，请重试；尚未确认完整解码通过。');decode.error=e.message;}}
  return {...info,...decode,fatal,warnings,technical:fatal.length?'failed':decode.fullDecode==='passed'?'passed':'partial',darkRatios:samples.dark,samples};
}
export async function concatenate(files,dimensions,onProgress=()=>{}){
  if(files.reduce((s,f)=>s+f.size,0)>450_000_000)throw Error('本集超过450MB的浏览器拼接安全上限。请分组拼接，或导出清单交给本地FFmpeg处理。');
  return serialFF(async f=>{const prefix=uid(),names=[],output=prefix+'_episode.mp4';const progress=({progress})=>onProgress(progress);f.on('progress',progress);
    try{const args=['-hide_banner'];for(let i=0;i<files.length;i++){const n=prefix+'_'+i+'.mp4';names.push(n);await f.writeFile(n,new Uint8Array(await files[i].arrayBuffer()));args.push('-i',n);}
      const [w,h]=dimensions;const filters=files.map((_,i)=>`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1,setpts=PTS-STARTPTS[v${i}];[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`).join(';');
      args.push('-filter_complex',filters+';'+files.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${files.length}:v=1:a=1[v][a]`,'-map','[v]','-map','[a]','-c:v','libx264','-preset','ultrafast','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart',output);
      const code=await f.exec(args,600000);if(code!==0)throw Error('拼接失败。请确认每镜都有音轨、画幅一致，或减少本集镜数。');const result=await f.readFile(output);return new Blob([result],{type:'video/mp4'});
    }finally{f.off('progress',progress);for(const n of [...names,output])await f.deleteFile(n).catch(()=>{});}
  });
}
export const videoMetadata=file=>metadata(file,'video');
