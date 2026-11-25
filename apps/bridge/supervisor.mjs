import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {atomicJSON,fetchManifest,stageRelease,installedRelease,newer} from './update-manifest.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let installed={};try{installed=JSON.parse(fs.readFileSync(path.join(here,'../engine-config.json'),'utf8'));}catch{}
const dataRoot=process.env.CALYPSO_DATA_DIR||installed.dataRoot||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'Calypso','Unified');
const port=Number(process.env.PORT||18791),root=path.join(dataRoot,'engine-updates'),releases=path.join(root,'releases'),pointer=path.join(root,'current.json'),lock=path.join(root,'supervisor.lock');
let child=null,current=null,candidate=null,checking=false,applying=false,closed=false,failedRevision=0,timer=null,watch=null,status={phase:'checking',message:'Checking for engine updates…'};
function existing(){try{return installedRelease(releases,JSON.parse(fs.readFileSync(pointer,'utf8')));}catch{return null;}}
function acquire(){
 fs.mkdirSync(root,{recursive:true});
 try{const pid=Number(fs.readFileSync(lock,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw Error('Calypso supervisor already running.');fs.unlinkSync(lock);}catch(e){if(e.message.includes('already running'))throw e;}
 fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
}
function releaseLock(){try{if(Number(fs.readFileSync(lock,'utf8'))===process.pid)fs.unlinkSync(lock);}catch{}}
function notify(phase,message){status={phase,message,availableRevision:candidate?.manifest?.revision||null};if(child?.connected)try{child.send({type:'update.status',status});}catch{}}
function target(r){return r?{entry:path.join(r.dir,'bridge','server.mjs'),web:path.join(r.dir,'web'),revision:r.manifest.revision,commit:r.manifest.commit}:{entry:path.join(here,'server.mjs'),web:process.env.CALYPSO_WEB_ROOT||path.resolve(here,'../web'),revision:0,commit:''};}
async function health(){try{const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(700)});if(r.ok)return await r.json();}catch{}return null;}
async function launch(release){
 const t=target(release),c=child=fork(t.entry,[],{cwd:path.dirname(t.entry),windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,CALYPSO_DATA_DIR:dataRoot,CALYPSO_WEB_ROOT:t.web,CALYPSO_ENGINE_REVISION:String(t.revision),CALYPSO_ENGINE_COMMIT:t.commit,CALYPSO_MANAGED_UPDATES:'1',PORT:String(port)}});
 const ok=await new Promise(resolve=>{
  let done=false;const finish=v=>{if(done)return;done=true;clearTimeout(timeout);resolve(v);};
  const timeout=setTimeout(()=>finish(false),20000);
  c.once('error',()=>finish(false));c.once('exit',()=>finish(false));
  c.on('message',m=>{if(m?.type==='engine.ready'&&m.revision===t.revision)finish(true);if(m?.type==='update.check')void check(true);});
 });
 if(!ok){if(c.exitCode===null&&c.signalCode===null)c.kill();await Promise.race([new Promise(r=>c.once('exit',r)),sleep(3000)]);if(child===c)child=null;throw Error('New engine did not start.');}
 current=release;if(release)atomicJSON(pointer,release.manifest);
 if(c.connected)c.send({type:'update.status',status});
 c.once('exit',()=>{if(child===c)child=null;if(!applying&&!closed){notify('error','Engine stopped; restarting the last working release.');setTimeout(()=>{if(!closed&&!child)void launch(current).catch(e=>notify('error',e.message));},2000);}});
}
async function drain(){
 if(!child?.connected)return false;const c=child;
 return new Promise(resolve=>{
  const listener=m=>{if(m?.type==='update.drain'){cleanup();resolve(m.ready===true);}};
  const cleanup=()=>{clearTimeout(timeout);c.off('message',listener);};
  const timeout=setTimeout(()=>{cleanup();resolve(false);},4000);
  c.on('message',listener);c.send({type:'update.prepare'});
 });
}
async function apply(){
 if(applying||closed||!candidate||!child)return;
 applying=true;const previous=current,next=candidate,old=child;
 try{
  if(!await drain()){notify('waiting','Update downloaded. Finishing current work before restarting.');return;}
  notify('restarting','Installing the tested engine update and reconnecting…');
  const exited=await Promise.race([new Promise(r=>{if(old.exitCode!==null||old.signalCode!==null)r(true);else old.once('exit',()=>r(true));}),sleep(60000).then(()=>false)]);
  if(!exited){notify('error','Engine is still shutting down; update deferred.');return;}
  child=null;
  try{await launch(next);candidate=null;notify('current','Calypso is up to date.');}
  catch{failedRevision=next.manifest.revision;candidate=null;await launch(previous);notify('error','Update could not start. Restored the previous working engine.');}
 }catch(e){notify('error','Update deferred: '+e.message);}
 finally{applying=false;}
}
async function check(force=false){
 if(checking||closed||applying)return;checking=true;
 try{
  const m=await fetchManifest();
  if(!newer(current?.manifest,m)){if(!candidate)notify('current','Calypso is up to date.');return;}
  if(m.revision===failedRevision&&!force){notify('error','Previous update did not start. Check again to retry.');return;}
  if(candidate?.manifest.revision!==m.revision){notify('downloading','Downloading the tested Calypso engine…');candidate=await stageRelease(releases,m);}
  if(child)await apply();
 }catch{notify('error','Update check could not finish. Existing engine is unchanged.');}
 finally{checking=false;}
}
async function shutdown(){
 if(closed)return;closed=true;clearInterval(timer);clearInterval(watch);
 if(child?.connected){const c=child;c.send({type:'engine.shutdown'});await Promise.race([new Promise(r=>c.once('exit',r)),sleep(30000)]);}
 releaseLock();process.exit(0);
}
async function main(){
 if(await health()){console.log('Calypso is already running.');return;}
 acquire();
 try{
  current=existing();await check();const first=candidate||current;
  try{await launch(first);if(candidate){candidate=null;notify('current','Calypso is up to date.');}}
  catch(e){if(!candidate)throw e;failedRevision=candidate.manifest.revision;candidate=null;await launch(current);notify('error','Update failed to start; previous engine restored.');}
  timer=setInterval(()=>void check(),60000);watch=setInterval(()=>{if(candidate&&!checking)void apply();},10000);
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>void shutdown());
 }catch(e){releaseLock();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
