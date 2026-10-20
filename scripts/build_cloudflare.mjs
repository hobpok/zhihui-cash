import { APP_RELEASE } from '../app/release-version.js';
// Publish only this explicit list, never the repository root or original materials.
import {readFile, writeFile, mkdir, readdir, lstat} from 'node:fs/promises';
import {resolve, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version=APP_RELEASE;
const output=resolve(root,'dist/cloudflare');
const sources=[
 'app/batch-layout.css','app/workbench.css','app/bootstrap.js','app/release-version.js','app/index.html','app/style.css','app/ui.js','app/calculation-controller.js','app/calculation-worker.js','app/metric-display.js','app/readiness-diagnostics.js','app/model.js','app/engine.js','app/execution.js','app/business.js','app/default-scenario.js','app/initial-data.js','app/initial-ui.js','app/core-rules.js','app/c-ui.js',
 'app/workspace-sync.js','app/workspace-ui.js','app/workspace.css','app/ai-proxy.js','app/analysis.js','app/analysis-ui.js','app/analysis.css','app/metric-catalog.js','app/display-labels.js',
 'app/ai-conversation.js','app/ai-draft.js','app/ai-ui.js','app/ai.css','app/planning.js','app/planning-solver.js','app/original-scenario.js',
 'docs/design/dense.html','docs/design/dense.css','docs/design/dense.js','docs/design/dense-data.js',
 'data/calculation/v2b/rules.json',
 'tutorial/index.html','tutorial/tutorial.css','tutorial/tutorial.js',
 'tutorial/images/01-plan.webp','tutorial/images/02-calculate.webp','tutorial/images/03-dispatch.webp','tutorial/images/04-settle.webp',
 'tutorial/images/05-recalculate.webp','tutorial/images/06-ai-check.webp','tutorial/images/07-ai-plan.webp',
];
const generated={
 'release.json':JSON.stringify({version})+'\n',
 'index.html':'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/app/"><title>智汇现金</title></head><body><a href="/app/">进入智汇现金</a></body></html>\n',
 '404.html':'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面不存在 · 智汇现金</title></head><body><h1>页面不存在</h1><p>请检查页面地址，或返回交易台继续操作。</p><a href="/app/">返回交易台</a></body></html>\n',
 '_redirects':'/ /app/ 302\n',
 '_headers':'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Cache-Control: public, max-age=0, must-revalidate\n/app/\n  Cache-Control: no-store\n/app/index.html\n  Cache-Control: no-store\n/release.json\n  Cache-Control: no-store\n',
 'robots.txt':'User-agent: *\nDisallow: /\n',
};
const allowed=new Set([...sources,...Object.keys(generated)]);
async function checkDirectory(path){
 let stat;try{stat=await lstat(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`Unsafe output directory: ${path}`);
 for(const entry of await readdir(path,{withFileTypes:true})){
  const full=resolve(path,entry.name);
  if(entry.isSymbolicLink())throw new Error('Output contains a symbolic link');
  if(entry.isDirectory())await checkDirectory(full);
  else if(!allowed.has(relative(output,full).replaceAll('\\','/')))throw new Error(`Unexpected publish file: ${full}`);
 }
}
// Refuse unknown existing contents instead of recursively deleting a directory.
try{if((await lstat(resolve(root,'dist'))).isSymbolicLink())throw new Error('dist must not be a link');}catch(e){if(e.code!=='ENOENT')throw e;}
await checkDirectory(output);
const manifest=[];
for(const name of allowed){
 let content=generated[name]??await readFile(resolve(root,name));
 if(Buffer.isBuffer(content)&&/\.(?:html|css|js|json)$/.test(name))content=content.toString('utf8');
 if(typeof content==='string'){
  // Keep the browser's whole module graph on the released version after an update.
  if(name.endsWith('.js'))content=content.replace(/((?:\bfrom\s*|\bimport\()['"])(\.\.?\/[^'"?]+\.js)(['"])/g,`$1$2?v=${version}$3`);
  if(name==='app/index.html')content=content.replace(/(name="application-version" content=")[^"]+/,`$1${version}`).replace(/(<span id="app-release" class="app-release">)v[^<]+/,`$1v${version}`);
  if(name.endsWith('.html'))content=content.replace(/(\b(?:src|href)=["'])([^"'?]+\.(?:js|css))(["'])/g,`$1$2?v=${version}$3`);
  if(name==='docs/design/dense.html')content=content.replace('<a href="index.html">旧版图稿</a>','<a href="/app/">返回交易台</a>');
  if(name.endsWith('.html')&&!content.includes('rel="icon"'))content=content.replace('</head>','<link rel="icon" href="data:,"></head>');
 }
 const bytes=Buffer.isBuffer(content)?content:Buffer.from(content,'utf8');
 const target=resolve(output,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);
 manifest.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await mkdir(resolve(root,'项目记录'),{recursive:true});
await writeFile(resolve(root,'项目记录/Cloudflare发布包.json'),JSON.stringify({version,builtAt:new Date().toISOString(),output:'dist/cloudflare',files:manifest,totalBytes:manifest.reduce((s,f)=>s+f.bytes,0),scope:'static prototype and demo fixtures only; no original materials, local saves, credentials or project records'},null,2));
console.log(JSON.stringify({output,files:manifest.length,bytes:manifest.reduce((s,f)=>s+f.bytes,0)}));


