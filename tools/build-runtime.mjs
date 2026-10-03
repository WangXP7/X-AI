// Pin the entire application module graph to one release, including dependencies.
// Entry-script cache busting alone leaves unversioned imports reusable from cache.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),version=JSON.parse(await readFile(new URL('package.json',root),'utf8')).version;
const names=(await readdir(new URL('src/',root))).filter(name=>name.endsWith('.js')).sort();
const imports=Object.fromEntries(names.map(name=>[`./src/${name}`,`./src/${name}?v=${version}`]));
const json=JSON.stringify({imports}),hash=createHash('sha256').update(json).digest('base64');
const file=new URL('index.html',root);let html=await readFile(file,'utf8');
html=html.replace(/\s*<!-- runtime-import-map -->[\s\S]*?<!-- \/runtime-import-map -->/,'');
html=html.replace(/script-src ([^;]*)/,(_,value)=>`script-src ${value.replace(/\s*'sha256-[^']+'/g,'')} 'sha256-${hash}'`);
html=html.replace('</head>',`  <!-- runtime-import-map -->\n  <script type="importmap">${json}</script>\n  <!-- /runtime-import-map -->\n</head>`);
html=html.replace(/(\.\/src\/(?:style\.css|app\.js))\?v=[\w.-]+/g,`$1?v=${version}`).replace(/X-AI \d+\.\d+\.\d+(?=<\/span>)/,`X-AI ${version}`);
await writeFile(file,html);
await writeFile(new URL('src/runtime-version.js',root),`export const APP_VERSION='${version}';\n`);
console.log(`Runtime ${version}: ${names.length} modules pinned; import-map CSP hash synchronized.`);
