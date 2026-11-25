import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,WEB_FILES,validateManifest} from '../apps/bridge/update-manifest.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'apps','web'),out=path.join(root,'dist','web');
fs.mkdirSync(out,{recursive:true});
const allowed=['index.html','app.js','store.js','styles.css','icon.svg','manifest.webmanifest','sw.js','updates.js'];
let bytes=0;for(const name of allowed){const data=fs.readFileSync(path.join(source,name));fs.writeFileSync(path.join(out,name),data);bytes+=data.length;}
fs.writeFileSync(path.join(out,'.nojekyll'),'');
console.log(`Calypso web built: ${allowed.length} files, ${(bytes/1024).toFixed(1)} KB total, zero runtime dependencies.`);

const commit=process.env.GITHUB_SHA,revision=Number(process.env.GITHUB_RUN_NUMBER||0);
if(commit&&revision){
 const entries=[];
 for(const [sub,names] of [['bridge',fs.readdirSync(path.join(root,'apps','bridge')).filter(n=>n.endsWith('.mjs'))],['web',WEB_FILES]]){
  for(const name of names){const data=fs.readFileSync(path.join(root,'apps',sub,name));entries.push({path:sub+'/'+name,size:data.length,sha256:hash(data)});}
 }
 const manifest=validateManifest({schema:1,revision,commit,files:entries});fs.writeFileSync(path.join(out,'engine-manifest.json'),JSON.stringify(manifest));
}
fs.copyFileSync(path.join(root,'scripts','Install-Calypso.cmd'),path.join(out,'Install-Calypso.cmd'));
