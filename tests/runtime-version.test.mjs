import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {APP_VERSION} from '../src/runtime-version.js';
test('every first-party module uses the release version and the import-map CSP hash matches',async()=>{
 const root=new URL('../',import.meta.url),html=await readFile(new URL('index.html',root),'utf8'),pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
 const json=html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];assert.ok(json);
 assert.ok(html.includes("'sha256-"+createHash('sha256').update(json).digest('base64')+"'"));assert.equal(APP_VERSION,pkg.version);
 const {imports}=JSON.parse(json);for(const name of (await readdir(new URL('src/',root))).filter(n=>n.endsWith('.js')))assert.equal(imports['./src/'+name],`./src/${name}?v=${pkg.version}`);
});
