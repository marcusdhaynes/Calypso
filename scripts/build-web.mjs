import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'apps','web'),out=path.join(root,'dist','web');
fs.mkdirSync(out,{recursive:true});
const allowed=['index.html','app.js','store.js','styles.css','icon.svg','manifest.webmanifest','sw.js'];
let bytes=0;for(const name of allowed){const data=fs.readFileSync(path.join(source,name));fs.writeFileSync(path.join(out,name),data);bytes+=data.length;}
fs.writeFileSync(path.join(out,'.nojekyll'),'');
console.log(`Calypso web built: ${allowed.length} files, ${(bytes/1024).toFixed(1)} KB total, zero runtime dependencies.`);
