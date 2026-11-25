import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

export const profiles=[
 {name:'quality',quant:'UD-IQ4_XS',gb:17.8,cpuMoe:30,k:'q4_0',v:'q8_0'},
 {name:'compact',quant:'UD-IQ3_XXS',gb:14.5,cpuMoe:25,k:'q4_0',v:'q4_0'}
];
export const MODEL='unsloth/Qwen3.6-35B-A3B-GGUF';
export const MIN_RATE=5;
export function serverArgs(p,port,threads=6,context=8192){
 return ['--hf-repo',MODEL,'--hf-file','Qwen3.6-35B-A3B-'+p.quant+'.gguf','--no-mmproj','--alias','calypso-35b','--host','127.0.0.1','--port',String(port),'-ngl','99','--n-cpu-moe',String(p.cpuMoe),'--flash-attn','on','--cache-type-k',p.k,'--cache-type-v',p.v,'--ctx-size',String(context),'-np','1','-t',String(threads),'--jinja','--reasoning-budget','4096','--reasoning-format','deepseek','--chat-template-kwargs','{"preserve_thinking":true}'];
}
export function selectWinner(results){
 return [...results].filter(r=>r.toolPass&&r.mathPass&&r.generationPass&&r.tokensPerSecond>=MIN_RATE&&r.minFreeRamGiB>=1&&r.minFreeVramMiB>=384).sort((a,b)=>profiles.findIndex(p=>p.name===a.profile)-profiles.findIndex(p=>p.name===b.profile)||b.tokensPerSecond-a.tokensPerSecond)[0]||null;
}
export function gpu(){
 try{
  const rows=execFileSync('nvidia-smi',['--query-gpu=name,memory.total,memory.free','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:5000}).trim().split(/\r?\n/).map(l=>l.split(',').map(x=>x.trim()));
  return rows.map(([name,total,free])=>({name,totalMiB:Number(total),freeMiB:Number(free)})).filter(x=>Number.isFinite(x.totalMiB)&&Number.isFinite(x.freeMiB)).sort((a,b)=>b.totalMiB-a.totalMiB)[0]||null;
 }catch{return null;}
}
export function freeDisk(dir){const d=fs.statfsSync(dir);return d.bavail*d.bsize;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();return new Promise((resolve,reject)=>{s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
export async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
export async function bench(profile,{binary,cache,logs,threads,context,signal,onProgress=()=>{}}){
 signal?.throwIfAborted();const port=await freePort(),base='http://127.0.0.1:'+port;
 const args=serverArgs(profile,port,threads,context);
 const log=fs.createWriteStream(path.join(logs,profile.name+'.log'));
 const child=spawn(binary,args,{windowsHide:true,env:{...process.env,LLAMA_CACHE:cache},stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let failed=null;child.on('error',e=>{failed=e.message;});
 let minRam=Infinity,minVram=Infinity;
 const sample=()=>{minRam=Math.min(minRam,os.freemem()/2**30);const g=gpu();if(g)minVram=Math.min(minVram,g.freeMiB);};
 let timer;const abort=()=>{void stop(child);};signal?.addEventListener('abort',abort,{once:true});
 try{
  console.log('Loading/downloading '+profile.quant+' (~'+profile.gb+' GB). See '+path.join(logs,profile.name+'.log'));
  const limit=Date.now()+6*60*60*1000;let ready=false;
  while(Date.now()<limit){
   signal?.throwIfAborted();onProgress('Loading or downloading '+profile.quant+'…');
   if(failed||child.exitCode!==null||child.signalCode!==null)throw Error(failed||'llama-server exited; inspect log');
   try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(2000),redirect:'error'});if(r.ok){ready=true;break;}}catch{}
   await sleep(2000);
  }
  if(!ready)throw Error('Server readiness timeout');
  onProgress('Benchmarking '+profile.quant+'…');sample();timer=setInterval(sample,3000);
  const call=async(messages,extra={})=>{
   const before=performance.now();
   const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'calypso-35b',messages,temperature:0.6,max_tokens:256,stream:false,...extra}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(240000)]):AbortSignal.timeout(240000),redirect:'error'});
   const data=await r.json();if(!r.ok||data.error)throw Error('Inference request failed: '+JSON.stringify(data.error||data).slice(0,300));
   return {message:data.choices?.[0]?.message||{},timings:data.timings||{},completionTokens:data.usage?.completion_tokens||0,wallSeconds:(performance.now()-before)/1000};
  };
  const user=content=>[{role:'user',content:content+'\n/no_think'}];
  const tool=await call(user('Call ping with integer value 42. Do not answer in prose.'),{tools:[{type:'function',function:{name:'ping',description:'Echo an integer',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value']}}}],tool_choice:'auto'});
  const toolPass=(tool.message.tool_calls||[]).some(c=>{try{return c.function.name==='ping'&&JSON.parse(c.function.arguments).value===42;}catch{return false;}});
  const math=await call(user('Return only the decimal integer result of 1723 + 45 - 123.'),{max_tokens:64});
  const mathPass=String(math.message.content||'').trim()==='1645';
  const measures=[];
  for(const subject of ['how photosynthesis works','how a search algorithm works','how rain forms']){
   const out=await call(user('Explain '+subject+' in 8 concise paragraphs, at least 130 words.'),{max_tokens:320});
   const text=String(out.message.content||'');const rate=Number(out.timings.predicted_per_second);
   measures.push({tokens:out.completionTokens,wallSeconds:out.wallSeconds,decodeTokensPerSecond:Number.isFinite(rate)&&rate>0?rate:null,endToEndTokensPerSecond:out.completionTokens/out.wallSeconds,visibleWords:text.trim().split(/\s+/).filter(Boolean).length});
  }
  sample();
  const rates=measures.map(m=>m.decodeTokensPerSecond??m.endToEndTokensPerSecond).sort((a,b)=>a-b);
  return {profile:profile.name,quant:profile.quant,context,threads,args,toolPass,mathPass,generationPass:measures.every(m=>m.visibleWords>=60),tokensPerSecond:rates[1],minFreeRamGiB:minRam,minFreeVramMiB:minVram,measures};
 }finally{signal?.removeEventListener('abort',abort);clearInterval(timer);await stop(child);log.end();}
}
export async function main(){
 const binary=process.env.CALYPSO_LLAMA_SERVER||'llama-server';
 const cache=path.resolve(process.env.CALYPSO_GGUF_CACHE||path.join(os.homedir(),'.cache','calypso-gguf'));
 const logs=path.resolve(process.env.CALYPSO_BENCH_DIR||path.join(os.homedir(),'calypso-benchmark'));
 fs.mkdirSync(cache,{recursive:true});fs.mkdirSync(logs,{recursive:true});
 const hardware={cpu:os.cpus()[0]?.model,logicalCores:os.cpus().length,ramGiB:os.totalmem()/2**30,freeRamGiB:os.freemem()/2**30,gpu:gpu(),freeDiskGB:freeDisk(cache)/1e9};
 console.log(JSON.stringify(hardware,null,2));
 if(!hardware.gpu||hardware.gpu.totalMiB<7500)throw Error('This CUDA profile requires a detected NVIDIA GPU with at least 8 GB VRAM.');
 if(hardware.gpu.freeMiB<6500||hardware.freeRamGiB<8)throw Error('Close games, Ollama, and other heavy processes first. At least 6500 MiB GPU memory and 8 GiB free system RAM required for this trial.');
 const threads=Math.max(1,Math.min(6,hardware.logicalCores));
 const context=8192;
 const results=[];
 for(const profile of profiles){
  if(freeDisk(cache)<(profile.gb+8)*1e9){results.push({profile:profile.name,error:'Insufficient disk reserve for safe download'});continue;}
  try{results.push(await bench(profile,{binary,cache,logs,threads,context}));}catch(e){results.push({profile:profile.name,error:e.message});}
  console.log(JSON.stringify(results.at(-1),null,2));
  await sleep(3000);
 }
 const winner=selectWinner(results);
 const report={date:new Date().toISOString(),hardware,minimumTokensPerSecond:MIN_RATE,results,winner};
 const dest=path.join(logs,'report.json');fs.writeFileSync(dest,JSON.stringify(report,null,2));
 console.log('Report: '+dest+'\n'+(winner?'Recommended: '+winner.quant:'No profile passed every check. Review logs and consider smaller models.'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
