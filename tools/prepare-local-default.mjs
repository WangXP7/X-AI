// One-time migration from the existing password vault. Password arrives only
// on stdin; neither it nor the API key is printed or written as plaintext.
import {readFile,writeFile} from 'node:fs/promises';
import {decryptKey} from '../src/core.js';
import {sealLocalDefault} from '../src/local-default.js';
try{
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const {password}=JSON.parse(input.replace(/^\uFEFF/,''));
  const vault=JSON.parse(await readFile(new URL('../private/default-vault.json',import.meta.url),'utf8'));
  const key=await decryptKey(vault,password);
  if(!/^sk-[A-Za-z0-9_-]{12,}$/.test(key))throw Error();
  await writeFile(new URL('../private/default-access.json',import.meta.url),JSON.stringify(await sealLocalDefault(key),null,2));
  process.stdout.write('Local default prepared. No credentials printed.\n');
}catch{process.stderr.write('Could not prepare local default. Existing vault was preserved.\n');process.exitCode=1;}
