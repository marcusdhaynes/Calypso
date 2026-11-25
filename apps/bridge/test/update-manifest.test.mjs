import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BRIDGE_REQUIRED,WEB_FILES,validateManifest,stageRelease,installedRelease,newer,hash} from '../update-manifest.mjs';
const bytes=Buffer.from('verified content');
const fixture=()=>({schema:1,revision:5,commit:'a'.repeat(40),files:[...BRIDGE_REQUIRED.map(x=>'bridge/'+x),...WEB_FILES.map(x=>'web/'+x)].map(path=>({path,size:bytes.length,sha256:hash(bytes)}))});
test('rejects malformed, traversal, duplicate, incomplete and nonmonotonic manifests',()=>{
 const m=fixture();assert.equal(newer({revision:4},m),true);assert.equal(newer({revision:5},m),false);
 for(const entry of ['bridge/../bad.mjs','web/evil.js','bridge/server.mjs'])assert.throws(()=>validateManifest({...m,files:[...m.files,{path:entry,size:bytes.length,sha256:hash(bytes)}]}));
 assert.throws(()=>validateManifest({...m,files:m.files.slice(1)}));
});
test('stages only pinned commit files and verifies each hash before activation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'calypso-update-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const m=fixture(),fetcher=async url=>{assert.ok(url.startsWith('https://raw.githubusercontent.com/marcusdhaynes/Calypso/'+m.commit+'/apps/'));return new Response(bytes);};
 const r=await stageRelease(root,m,fetcher);assert.ok(installedRelease(root,m));assert.equal(fs.readFileSync(path.join(r.dir,'bridge','server.mjs'),'utf8'),bytes.toString());
 const bad={...m,revision:6};await assert.rejects(stageRelease(root,bad,async()=>new Response('tampered')),/Integrity/);assert.equal(installedRelease(root,bad),null);assert.ok(installedRelease(root,m));
});
