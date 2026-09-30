// Uncompressed ZIP keeps already-compressed image/audio bytes intact. One
// browser download avoids per-file download permissions and duplicate names.
import {safeName} from './core.js';
const table=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
async function crc32(blob,onBytes=()=>{}){
  let crc=0xffffffff,read=0,lastYield=performance.now();const reader=blob.stream().getReader();
  try{while(true){const {value,done}=await reader.read();if(done)break;for(const byte of value)crc=table[(crc^byte)&255]^(crc>>>8);read+=value.length;onBytes(read);if(performance.now()-lastYield>60){await new Promise(r=>setTimeout(r,0));lastYield=performance.now();}}}finally{reader.releaseLock();}
  return (crc^0xffffffff)>>>0;
}
export const ARCHIVE_LIMIT=500_000_000;
export function archiveNames(names){
  const used=new Set();return names.map(raw=>{const base=safeName(raw)||'asset',dot=base.lastIndexOf('.'),stem=dot>0?base.slice(0,dot):base,ext=dot>0?base.slice(dot):'';let value=base,n=2;while(used.has(value.toLowerCase()))value=`${stem}_${n++}${ext}`;used.add(value.toLowerCase());return value;});
}
export async function createArchive(entries,{onProgress=()=>{},cancelled=()=>false}={}){
  if(entries.length>65535||entries.reduce((n,e)=>n+e.blob.size,0)>ARCHIVE_LIMIT)throw Error('单个 ZIP 最多 500MB，请减少勾选数量，分批下载。');
  const files=[],central=[],encoder=new TextEncoder(),names=archiveNames(entries.map(e=>e.name));let offset=0,centralSize=0;
  for(let i=0;i<entries.length;i++){
    if(cancelled())throw new DOMException('已停止打包，未发起下载。','AbortError');
    const {blob}=entries[i],name=encoder.encode(names[i]);
    if(name.length>65535)throw Error('文件名太长，请缩短后重试。');
    const crc=await crc32(blob,bytes=>onProgress(i,entries.length,bytes,blob.size));
    const local=new Uint8Array(30+name.length),l=new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);
    l.setUint32(14,crc,true);l.setUint32(18,blob.size,true);l.setUint32(22,blob.size,true);l.setUint16(26,name.length,true);local.set(name,30);
    files.push(local,blob);
    const entry=new Uint8Array(46+name.length),c=new DataView(entry.buffer);
    c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);
    c.setUint32(16,crc,true);c.setUint32(20,blob.size,true);c.setUint32(24,blob.size,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);entry.set(name,46);
    central.push(entry);centralSize+=entry.length;offset+=local.length+blob.size;onProgress(i+1,entries.length,0,0);
  }
  if(cancelled())throw new DOMException('已停止打包，未发起下载。','AbortError');
  const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  return new Blob([...files,...central,end],{type:'application/zip'});
}
