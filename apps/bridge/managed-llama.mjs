import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {profiles,serverArgs,selectWinner,bench,gpu,freeDisk,stop} from './benchmark-35b.mjs';

export const MODEL_ID='calypso-35b',PROVIDER_ID='calypso-llama',PORT=18792;
const TAG='b12722';
const MODEL_HASHES={'UD-IQ4_XS':'649d7508507b84638732c4f52c24c8b15843c6dca2f3ff793ae07c14a67ebbb3','UD-IQ3_XXS':'9c964e657212fea1f24905dd7b0a89b82fd807d19fab0b41da14251b07b88fbe'};
const MODEL_ORIGIN='https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/';
const ASSETS=[
 ['llama-b12722-bin-win-cuda-12.4-x64.zip','7f2655c88e80b30cbf94cbd2be0deb46c04920b6fd2c761d167fe443c0c07ed1'],
 ['cudart-llama-bin-win-cuda-12.4-x64.zip','8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6']
];
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function eligible({platform=process.platform,arch=process.arch,ramGiB=os.totalmem()/2**30,device=gpu()}={}){
 return platform==='win32'&&arch==='x64'&&ramGiB>=14&&ramGiB<28&&device?.totalMiB>=7500;
}
export function providerConfig(key,context=8192){
 return {baseUrl:'http://127.0.0.1:'+PORT+'/v1',apiKey:key,api:'openai-completions',timeoutSeconds:300,models:[{id:MODEL_ID,name:'Calypso Qwen3.6 35B (local CUDA)',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:context,maxTokens:2048,compat:{toolSchemaProfile:'llamacpp'}}]};
}
export async function prepareWeights(profile,cache,signal,report){
 const name='Qwen3.6-35B-A3B-'+profile.quant+'.gguf',sha=MODEL_HASHES[profile.quant],file=path.join(cache,name),marker=file+'.verified',partial=file+'.partial';
 if(!sha)throw Error('Unknown model artifact');
 if(fs.existsSync(file)){
  const stat=fs.statSync(file);let saved;try{saved=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{}
  if(saved?.sha===sha&&saved.size===stat.size&&saved.mtime===stat.mtimeMs)return file;
  const digest=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file)){signal.throwIfAborted();digest.update(chunk);}
  if(digest.digest('hex')!==sha)throw Error('Cached model hash mismatch: '+name+'; remove the corrupt file and retry.');
  fs.writeFileSync(marker,JSON.stringify({sha,size:stat.size,mtime:stat.mtimeMs}));return file;
 }
 if(freeDisk(cache)<(profile.gb+8)*1e9)throw Error('Insufficient disk space for '+name+' with 8 GB reserve.');
 const r=await fetch(MODEL_ORIGIN+name,{signal:AbortSignal.any([signal,AbortSignal.timeout(12*60*60*1000)])});
 if(!r.ok||!r.body)throw Error('Model download failed: '+r.status);
 const expected=Number(r.headers.get('content-length'))||profile.gb*1e9,hash=crypto.createHash('sha256');let count=0,last=-1;
 try{
  await pipeline(Readable.fromWeb(r.body),new Transform({transform(chunk,encoding,cb){hash.update(chunk);count+=chunk.length;const percent=Math.min(99,Math.floor(count/expected*100));if(percent!==last){last=percent;report('downloading','Downloading '+profile.quant+' · '+percent+'%',{percent});}cb(null,chunk);}}),fs.createWriteStream(partial,{flags:'w'}),{signal});
  if(hash.digest('hex')!==sha)throw Error('Model download SHA-256 mismatch: '+name);
  fs.renameSync(partial,file);const stat=fs.statSync(file);fs.writeFileSync(marker,JSON.stringify({sha,size:stat.size,mtime:stat.mtimeMs}));return file;
 }finally{fs.rmSync(partial,{force:true});}
}
async function install(root,signal,report){
 const override=process.env.CALYPSO_LLAMA_SERVER;
 if(override&&fs.existsSync(override))return override;
 const dest=path.join(root,TAG),bin=path.join(dest,'llama-server.exe');
 if(fs.existsSync(bin)&&fs.existsSync(path.join(dest,'.verified')))return bin;
 const stage=fs.mkdtempSync(path.join(root,'install-'));
 try{
  for(const [name,sha] of ASSETS){
   signal.throwIfAborted();report('installing','Downloading verified CUDA runtime: '+name);
   const file=path.join(stage,name);
   const r=await fetch('https://github.com/ggml-org/llama.cpp/releases/download/'+TAG+'/'+name,{signal:AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)])});
   if(!r.ok||!r.body)throw Error('Runtime download failed: '+r.status);
   const hash=crypto.createHash('sha256');
   await pipeline(Readable.fromWeb(r.body),new Transform({transform(chunk,encoding,cb){hash.update(chunk);cb(null,chunk);}}),fs.createWriteStream(file,{flags:'wx'}),{signal});
   if(hash.digest('hex')!==sha)throw Error('Runtime checksum mismatch: '+name);
   // Use a fixed PowerShell script and pass paths through environment, not interpolated code.
   await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:CALYPSO_ZIP -DestinationPath $env:CALYPSO_EXTRACT -Force'],{windowsHide:true,signal,timeout:300000,env:{...process.env,CALYPSO_ZIP:file,CALYPSO_EXTRACT:stage}});
   fs.unlinkSync(file);
  }
  if(!fs.existsSync(path.join(stage,'llama-server.exe')))throw Error('Expected CUDA executable not found in verified archives.');
  fs.writeFileSync(path.join(stage,'.verified'),TAG);
  if(fs.existsSync(dest))throw Error('Existing runtime directory is incomplete; remove it before retrying: '+dest);
  fs.renameSync(stage,dest);return bin;
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
export function createManagedLlama({dataRoot,onUpdate=()=>{},hardware=()=>({platform:process.platform,arch:process.arch,ramGiB:os.totalmem()/2**30,device:gpu()}),installer=install,benchmark=bench,weights=prepareWeights}={}){
 const root=path.join(dataRoot,'local-inference'),cache=path.join(root,'gguf'),logs=path.join(root,'logs'),receipt=path.join(root,'selection.json');
 let status={phase:'idle',message:'Checking optimized local inference.'},pending=null,child=null,controller=null,key=null,ready=false,closed=false;
 const report=(phase,message,extra={})=>{status={phase,message,...extra};onUpdate(status);};
 function auth(){return {Authorization:'Bearer '+key};}
 async function halt(){ready=false;const c=child;child=null;if(c)await stop(c);}
 async function launch(binary,p,threads,context,signal,modelPath){
  await halt();signal.throwIfAborted();
  // Never reuse an unknown service on this port.
  try{await fetch('http://127.0.0.1:'+PORT+'/health',{signal:AbortSignal.timeout(600)});throw Error('Calypso inference port 18792 is occupied.');}catch(e){if(e.message.includes('occupied'))throw e;}
  const keyPath=path.join(root,'local-key');
  if(!fs.existsSync(keyPath))fs.writeFileSync(keyPath,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  key=fs.readFileSync(keyPath,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid local inference credential.');
  const args=serverArgs(p,PORT,threads,context,modelPath).concat(['--api-key',key]);
  const log=fs.createWriteStream(path.join(logs,'server.log'),{flags:'a'});
  const c=child=spawn(binary,args,{windowsHide:true,env:{...process.env,LLAMA_CACHE:cache},stdio:['ignore','pipe','pipe']});
  c.stdout.pipe(log,{end:false});c.stderr.pipe(log,{end:false});let error=null;c.on('error',e=>{error=e.message;});
  c.once('close',()=>{log.end();if(child===c){child=null;ready=false;if(!closed&&!signal.aborted)report('error','Optimized model server stopped. Restart automatic setup.');}});
  const until=Date.now()+20*60*1000;
  while(Date.now()<until){
   signal.throwIfAborted();if(error||c.exitCode!==null||c.signalCode!==null)throw Error(error||'CUDA server exited; inspect server.log.');
   try{const r=await fetch('http://127.0.0.1:'+PORT+'/v1/models',{headers:auth(),signal:AbortSignal.timeout(2000)});if(r.ok&&(await r.json()).data?.some(m=>m.id===MODEL_ID)){ready=true;return;}}catch{}
   await sleep(1500);
  }
  throw Error('Optimized model server readiness timed out.');
 }
 async function run(signal,force){
  await halt();const hw=hardware();if(!eligible(hw))return null;
  if(hw.device.freeMiB<6500||os.freemem()/2**30<8)throw Error('Close GPU-heavy apps or exit Ollama to free at least 6.5 GB VRAM and 8 GiB RAM; then retry automatic setup.');
  for(const d of [root,cache,logs])fs.mkdirSync(d,{recursive:true});
  if(freeDisk(root)<2e9)throw Error('Not enough disk space for the CUDA runtime.');
  const binary=await installer(root,signal,report),threads=Math.max(1,Math.min(6,os.cpus().length));
  const fingerprint=JSON.stringify({revision:2,tag:TAG,binary,device:hw.device.name,ram:Math.round(hw.ramGiB),cpu:os.cpus()[0]?.model});
  let winner=null;
  if(!force)try{const saved=JSON.parse(fs.readFileSync(receipt,'utf8'));if(saved.fingerprint===fingerprint&&profiles.some(p=>p.name===saved.winner?.profile)&&selectWinner([saved.winner]))winner=saved.winner;}catch{}
  if(!winner){
   const results=[];
   for(const p of profiles){
    signal.throwIfAborted();
    report('downloading','Preparing '+p.quant+' (approximately '+p.gb+' GB).');
    try{
     const modelPath=await weights(p,cache,signal,report);
     // Prefer a 16K agent context. Retry with 8K only if that fails.
     for(const context of [16384,8192]){
      signal.throwIfAborted();report('testing','Testing '+p.quant+' at '+context+' tokens…');
      try{const result=await benchmark(p,{binary,cache,logs,threads,context,modelPath,signal,onProgress:message=>report(message.startsWith('Benchmarking')?'testing':'starting',message)});results.push(result);if(selectWinner([result]))break;}catch(e){if(signal.aborted)throw e;results.push({profile:p.name,context,error:e.message});}
     }
    }catch(e){if(signal.aborted)throw e;results.push({profile:p.name,error:e.message});}
   }
   winner=selectWinner(results);fs.writeFileSync(receipt,JSON.stringify({fingerprint,winner,results},null,2));
   if(!winner)throw Error('Neither 35B profile passed the speed, tool and memory checks. See local benchmark logs.');
  }
  report('starting','Starting verified '+winner.quant+' model…');
  const profile=profiles.find(p=>p.name===winner.profile);const modelPath=await weights(profile,cache,signal,report);
  await launch(binary,profile,threads,winner.context,signal,modelPath);
  report('ready',winner.quant+' ready · '+winner.tokensPerSecond.toFixed(1)+' tokens/sec',{model:MODEL_ID,tps:winner.tokensPerSecond,quant:winner.quant,context:winner.context});
  return MODEL_ID;
 }
 return {get status(){return status;},get ready(){return ready;},get config(){if(!ready)throw Error('Optimized inference not ready');return providerConfig(key,status.context);},
  eligible:()=>eligible(hardware()),
  start(force=false){if(closed)return Promise.resolve(null);if(pending)return pending;controller=new AbortController();const signal=controller.signal;pending=run(signal,force).catch(async e=>{await halt();report('error',e.message);return null;}).finally(()=>{pending=null;});return pending;},
  async stop(){controller?.abort();await halt();if(pending)await pending;},async close(){closed=true;controller?.abort();await halt();if(pending)await pending;},
  async request(body,signal){if(!ready)throw Error('Optimized local model is not ready.');return openAIAsOllama(await fetch('http://127.0.0.1:'+PORT+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...auth()},body:JSON.stringify({model:MODEL_ID,messages:body.messages,stream:body.stream,max_tokens:Math.min(body.options?.num_predict||2048,4096),...(body.format==='json'?{response_format:{type:'json_object'}}:{})}),signal,redirect:'error'}),body.stream);}
 };
}
export async function openAIAsOllama(response,stream){
 if(!response.ok)return response;
 if(!stream){const d=await response.json();const c=d.choices?.[0];return Response.json({message:{content:c?.message?.content||''},done_reason:c?.finish_reason,error:d.error?.message||(!c?'No response choice':undefined)});}
 if(!response.body)throw Error('Empty model stream.');
 const reader=response.body.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();let buf='',finished=false;
 return new Response(new ReadableStream({
  async pull(out){try{
   while(!finished){
    let i=buf.indexOf('\n');
    if(i<0){const r=await reader.read();if(r.done){buf+=decoder.decode();if(!buf.trim()){finished=true;out.close();return;}buf+='\n';}else{buf+=decoder.decode(r.value,{stream:true});}continue;}
    const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
    if(!line.startsWith('data:'))continue;
    const raw=line.slice(5).trim();
    if(raw==='[DONE]'){finished=true;out.enqueue(encoder.encode('{"done":true}\n'));out.close();await reader.cancel();return;}
    const d=JSON.parse(raw);if(d.error)throw Error(d.error.message||'Inference error');
    const choice=d.choices?.[0];if(!choice)continue;
    const content=choice.delta?.content||'';
    if(content||choice.finish_reason){out.enqueue(encoder.encode(JSON.stringify({message:{content},done:!!choice.finish_reason,done_reason:choice.finish_reason})+'\n'));return;}
   }
  }catch(e){out.error(e);await reader.cancel().catch(()=>{});}},
  cancel(reason){return reader.cancel(reason);}
 }),{headers:{'Content-Type':'application/x-ndjson'}});
}
