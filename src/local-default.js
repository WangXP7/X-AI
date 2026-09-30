// Local convenience envelope, deliberately excluded from public deployment.
// Its opening key accompanies the ciphertext: possession of the private bundle
// grants access. This is not a password vault or a way to hide a public API key.
const encode=bytes=>btoa(String.fromCharCode(...bytes));
const decode=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export async function sealLocalDefault(value){
  const openingKey=crypto.getRandomValues(new Uint8Array(32));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await crypto.subtle.importKey('raw',openingKey,'AES-GCM',false,['encrypt']);
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value));
  return {format:'x-ai-local-default-v1',openingKey:encode(openingKey),iv:encode(iv),cipher:encode(new Uint8Array(cipher))};
}
export async function openLocalDefault(envelope){
  if(envelope?.format!=='x-ai-local-default-v1'||
    !['openingKey','iv','cipher'].every(k=>typeof envelope[k]==='string'&&envelope[k].length<20000))throw Error('默认密钥文件格式不正确');
  const raw=decode(envelope.openingKey),iv=decode(envelope.iv);
  if(raw.length!==32||iv.length!==12)throw Error('默认密钥文件格式不正确');
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  const text=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,decode(envelope.cipher));
  const value=new TextDecoder().decode(text);
  if(!/^sk-[A-Za-z0-9_-]{12,}$/.test(value))throw Error('默认密钥格式不正确');
  return value;
}
