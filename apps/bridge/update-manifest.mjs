import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const ORIGIN='https://marcusdhaynes.github.io/Calypso/';
export const WEB_FILES=['index.html','app.js','store.js','styles.css','icon.svg','manifest.webmanifest','sw.js','updates.js'];
export const BRIDGE_REQUIRED=['server.mjs','supervisor.mjs','update-manifest.mjs','auto-model.mjs','managed-llama.mjs','benchmark-35b.mjs','understanding.mjs','course-authoring.mjs','verify-local.mjs'];
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function validateManifest(m){
 if(m?.schema!==1||!Number.isSafeInteger(m.revision)||m.revision<1||!(/^[a-f0-9]{40}$/).test(m.commit)||!Array.isArray(m.files)||m.files.length>60)throw Error('Invalid engine update manifest.');
 const seen=new Set();
 for(const f of m.files){
  if(typeof f.path!=='string'||!(/^(?:bridge\/[a-z0-9-]+\.mjs|web\/[a-z0-9.-]+)$/).test(f.path)||f.path.startsWith('web/')&&!WEB_FILES.includes(f.path.slice(4))||seen.has(f.path)||!Number.isSafeInteger(f.size)||f.size<1||f.size>2e6||!(/^[a-f0-9]{64}$/).test(f.sha256))throw Error('Invalid update file entry.');
  seen.add(f.path);
 }
 for(const p of [...BRIDGE_REQUIRED.map(x=>'bridge/'+x),...WEB_FILES.map(x=>'web/'+x)])if(!seen.has(p))throw Error('Incomplete engine update: '+p);
 return m;
}
export function newer(current,manifest){return manifest.revision>(current?.revision||0);}
export function checkBytes(entry,bytes){if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('Integrity check failed: '+entry.path);return bytes;}
export function releaseName(m){return String(m.revision)+'-'+m.commit;}
export function atomicJSON(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}
export function installedRelease(root,m){
 try{validateManifest(m);const dir=path.join(root,releaseName(m));for(const entry of m.files)checkBytes(entry,fs.readFileSync(path.join(dir,entry.path)));return {dir,manifest:m};}catch{return null;}
}
export async function fetchManifest(fetcher=fetch){
 const r=await fetcher(ORIGIN+'engine-manifest.json',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw Error('Update check unavailable (HTTP '+r.status+').');
 const text=await r.text();if(text.length>100000)throw Error('Oversized manifest.');
 return validateManifest(JSON.parse(text));
}
export async function stageRelease(root,m,fetcher=fetch){
 validateManifest(m);fs.mkdirSync(root,{recursive:true});
 const existing=installedRelease(root,m);if(existing)return existing;
 const stage=fs.mkdtempSync(path.join(root,'.stage-')),dest=path.join(root,releaseName(m));
 try{
  for(const entry of m.files){
   const r=await fetcher('https://raw.githubusercontent.com/marcusdhaynes/Calypso/'+m.commit+'/apps/'+entry.path,{signal:AbortSignal.timeout(25000),redirect:'error'});
   if(!r.ok)throw Error('Could not download '+entry.path+' (HTTP '+r.status+').');
   const bytes=Buffer.from(await r.arrayBuffer());checkBytes(entry,bytes);
   const file=path.join(stage,entry.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});
  }
  if(fs.existsSync(dest))throw Error('Existing release failed integrity checks. The running release is untouched.');
  fs.renameSync(stage,dest);return {dir:dest,manifest:m};
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
