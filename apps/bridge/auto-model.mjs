import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const GiB=1024**3;
// Conservative physical RAM thresholds leave room for Windows, Calypso, KV cache and tools.
// Sizes are decimal GB as listed in the official Ollama registry; free disk is measured separately.
export const MODEL_TIERS=[
 {id:'qwen3.5:122b',b:122,ram:104,gb:81,context:8192},
 {id:'gpt-oss:120b',b:120,ram:84,gb:65,context:8192},
 {id:'qwen3.6:35b-a3b',b:35,ram:29,gb:23,context:8192},
 {id:'qwen3.5:35b',b:35,ram:28,gb:22,context:8192},
 {id:'qwen3.5:27b',b:27,ram:24,gb:17,context:8192},
 {id:'gpt-oss:20b',b:20,ram:22,gb:14,context:8192},
 {id:'qwen3.5:9b',b:9,ram:14,gb:7,context:8192},
 {id:'qwen3.5:4b',b:4,ram:7,gb:4,context:8192}
];
export function planModels({ramGiB,diskBytes,installed=[]}){
 return MODEL_TIERS.filter(m=>ramGiB>=m.ram&&(installed.includes(m.id)||diskBytes>=(m.gb+5)*1e9));
}
export function localModel(m){return Boolean(m&&m.size>0&&!m.remote_host&&!m.remote_model&&!/(^|[:/\-])cloud($|[:/\-])/i.test(m.name));}
function diskFree(){
 let dir=process.env.OLLAMA_MODELS||path.join(os.homedir(),'.ollama','models');
 while(!fs.existsSync(dir)){const parent=path.dirname(dir);if(parent===dir)return 0;dir=parent;}
 try{const d=fs.statfsSync(dir);return d.bavail*d.bsize;}catch{return 0;}
}
function ollamaBinary(){
 const candidates=process.platform==='win32'?[path.join(process.env.LOCALAPPDATA||'','Programs','Ollama','ollama.exe'),path.join(process.env.ProgramFiles||'','Ollama','ollama.exe')]:['/usr/local/bin/ollama','/usr/bin/ollama','/opt/homebrew/bin/ollama','/Applications/Ollama.app/Contents/Resources/ollama'];
 return candidates.find(x=>fs.existsSync(x))||'ollama';
}
export function createAutoModel({url='http://127.0.0.1:11434',onUpdate=()=>{},fetcher=fetch,hardware=()=>({ramGiB:os.totalmem()/GiB,diskBytes:diskFree()}),startRuntime=true,minSpeed=5}={}){
 let pending=null,controller=null,child=null,closed=false;
 let status={phase:'idle',message:'Automatic local model selection is enabled.'};
 const update=(phase,message,extra={})=>{status={phase,message,...extra};onUpdate(status);};
 async function request(route,body,signal,ms=15000){
  const r=await fetcher(url+route,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(ms)])});
  if(!r.ok)throw Error('Ollama '+route+' returned HTTP '+r.status);
  return r;
 }
 async function installed(signal){const r=await request('/api/tags',undefined,signal,3000);return ((await r.json()).models||[]).filter(localModel).map(m=>m.name);}
 async function ensureRuntime(signal){
  try{return await installed(signal);}catch(e){if(signal.aborted||!startRuntime)throw e;}
  update('starting','Starting installed Ollama runtime…');
  let spawnError=false;
  child=spawn(ollamaBinary(),['serve'],{windowsHide:true,stdio:'ignore',env:{...process.env,OLLAMA_HOST:'127.0.0.1:11434',OLLAMA_FLASH_ATTENTION:'1',OLLAMA_KV_CACHE_TYPE:'q8_0',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_NO_CLOUD:'1'}});
  child.on('error',()=>{spawnError=true;});
  for(let i=0;i<30&&!signal.aborted&&!spawnError;i++){
   try{return await installed(signal);}catch{await new Promise(r=>setTimeout(r,1000));}
  }
  throw Error('Ollama could not start. Install or update it from https://ollama.com/download, then restart Calypso.');
 }
 async function pull(model,signal){
  update('downloading','Downloading '+model.id+' ('+model.gb+' GB maximum estimate).',{model:model.id,percent:0});
  const r=await request('/api/pull',{model:model.id,stream:true},signal,12*60*60*1000);
  let buf='',success=false,reported=-1;const decoder=new TextDecoder(),layers=new Map();
  function consume(line){
   if(!line.trim())return;const d=JSON.parse(line);if(d.error)throw Error('Model download failed: '+d.error);
   if(d.digest&&d.total>0){layers.set(d.digest,{done:d.completed||0,total:d.total});const done=[...layers.values()].reduce((n,x)=>n+x.done,0);const percent=Math.min(99,Math.floor(done/(model.gb*1e9)*100));if(percent!==reported){reported=percent;update('downloading','Downloading '+model.id+'…',{model:model.id,percent});}}
   if(d.status==='success')success=true;
  }
  for await(const chunk of r.body){buf+=decoder.decode(chunk,{stream:true});let i;while((i=buf.indexOf('\n'))>=0){consume(buf.slice(0,i));buf=buf.slice(i+1);}}
  buf+=decoder.decode();consume(buf);if(!success)throw Error('Model download ended without a success receipt.');
 }
 async function validate(model,signal){
  update('testing','Testing tool use, speed and memory for '+model.id+'…',{model:model.id});
  const options={num_ctx:model.context,num_predict:96,temperature:0};
  const r=await request('/api/chat',{model:model.id,stream:false,keep_alive:'30m',options,messages:[{role:'user',content:'Call the function ping with value 42. Do not answer in prose.'}],tools:[{type:'function',function:{name:'ping',description:'Echo a number',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value']}}}]},signal,240000);
  const d=await r.json();if(d.error||!d.message?.tool_calls?.some(c=>c.function?.name==='ping'&&Number(c.function?.arguments?.value)===42))throw Error('Tool-call smoke test failed.');
  const speedResponse=await request('/api/chat',{model:model.id,stream:false,keep_alive:'30m',options,messages:[{role:'user',content:'Write five short complete sentences explaining how rain forms.'}],think:false},signal,240000);
  const v=await speedResponse.json(),tps=v.eval_duration>0?v.eval_count/(v.eval_duration/1e9):0;
  if(v.error||!v.message?.content?.trim()||!Number.isFinite(tps)||tps<minSpeed)throw Error('Generation speed below '+minSpeed+' tokens/sec or no usable response.');
  return Math.round(tps*10)/10;
 }
 async function run(signal){
  let names=await ensureRuntime(signal);const hw=hardware();const candidates=planModels({...hw,installed:names});
  if(!candidates.length)throw Error('Not enough RAM or free model storage for the automatic candidates. Free space or select an installed local model manually.');
  let last='';for(const m of candidates){
   if(signal.aborted)throw Error('Setup stopped.');
   try{
    if(!names.includes(m.id)){if(hardware().diskBytes<(m.gb+5)*1e9)continue;await pull(m,signal);names=await installed(signal);}
    if(!names.includes(m.id))throw Error('Downloaded model was not found as local weights.');
    const tps=await validate(m,signal);update('ready',m.id+' ready · '+tps+' tokens/sec',{model:m.id,tps,context:m.context,ramGiB:Math.round(hw.ramGiB)});return m.id;
   }catch(e){if(signal.aborted)throw e;last=m.id+': '+e.message;update('testing','Candidate rejected; trying a smaller model.',{model:m.id,reason:last});try{await request('/api/generate',{model:m.id,prompt:'',keep_alive:0,stream:false},signal,15000);}catch{}}
  }
  throw Error('No candidate passed the automatic checks. '+last);
 }
 return {get status(){return status;},start(){if(closed)return Promise.resolve(null);if(pending)return pending;controller=new AbortController();pending=run(controller.signal).catch(e=>{update('error',e.message);return null;}).finally(()=>{pending=null;});return pending;},stop(){controller?.abort();},close(){closed=true;controller?.abort();/* Do not stop the user's shared Ollama runtime. */}};
}
