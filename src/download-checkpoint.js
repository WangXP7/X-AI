import {sha256,safeID} from './core.js';
import {readFile,writeFile,blob} from './storage.js';
const stableFile=async file=>new Blob([await file.arrayBuffer()],{type:'video/mp4'});

// A receipt closes the crash window between saving raw bytes and project.json.
// Never infer ownership from a filename alone, or adopt a partial/corrupt download.
export function rawDownloadPath(job,attempt=job.attempts.at(-1)){
  if(!safeID(job.id)||!safeID(job.episode)||!Number.isInteger(attempt?.number)||attempt.number<1)throw Error('原片检查点编号无效');
  const sequence=attempt.downloadSequence;
  if(sequence!==undefined&&(!Number.isInteger(sequence)||sequence<1))throw Error('原片下载版本无效');
  return `raw/${job.episode}/${job.id}_v${attempt.number}${sequence?'_d'+sequence:''}.mp4`;
}
export async function writeDownloadReceipt(folder,job,attempt){
  if(!attempt.videoId)return;
  await writeFile(folder,rawDownloadPath(job,attempt)+'.json',JSON.stringify({schema:'x-ai-download-v1',jobUid:job.uid,attempt:attempt.number,videoId:attempt.videoId,requestHash:attempt.requestHash||null,path:attempt.rawPath,sha256:attempt.rawSha256,bytes:attempt.rawBytes,savedAt:attempt.downloadCompleteAt},null,2));
}
export async function savedDownload(folder,job){
  const a=job.attempts.at(-1);if(!a||a.forceDownload)return null;
  let file;
  if(a.rawBlobKey&&a.rawSha256)try{file=await blob(a.rawBlobKey);if(await sha256(file)===a.rawSha256)return file;}catch{}
  if(folder&&a.rawPath&&a.rawSha256)try{file=await stableFile(await readFile(folder,a.rawPath));if(await sha256(file)===a.rawSha256)return file;}catch{}
  if(!folder||!a.videoId)return null;
  try{
    const path=rawDownloadPath(job,a),receiptFile=await readFile(folder,path+'.json');if(receiptFile.size>8192)return null;
    const receipt=JSON.parse(await receiptFile.text());
    if(receipt.schema!=='x-ai-download-v1'||receipt.jobUid!==job.uid||receipt.attempt!==a.number||receipt.videoId!==a.videoId||receipt.requestHash!==(a.requestHash||null)||receipt.path!==path||!/^[a-f0-9]{64}$/.test(receipt.sha256)||receipt.sha256===a.discardedDownload?.sha256)return null;
    file=await stableFile(await readFile(folder,path));
    if(file.size!==receipt.bytes||file.size<1024||file.size>512_000_000||await sha256(file)!==receipt.sha256)return null;
    return file;
  }catch{return null;}
}
