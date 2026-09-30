// Receive a key on stdin, write ONLY ciphertext. stdout is an unlock password;
// provisioners must capture and protect it, never publish it or place it in git.
import {webcrypto,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const {encryptKey}=await import('../src/core.js');
let input='';for await(const chunk of process.stdin)input+=chunk;
const key=input.trim();
if(!/^sk-[\w-]{12,}$/.test(key))throw Error('Invalid key format');
const password=randomBytes(24).toString('base64url');
await mkdir(new URL('../private/',import.meta.url),{recursive:true});
await writeFile(new URL('../private/default-vault.json',import.meta.url),JSON.stringify(await encryptKey(key,password),null,2));
process.stdout.write(password);
