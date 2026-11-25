import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {gpu} from './benchmark-35b.mjs';
import {MODEL_ID,PROVIDER_ID} from './managed-llama.mjs';

export function actualAgentModel(result){
 const m=result?.data?.result?.meta?.agentMeta||{};
 return {provider:typeof m.provider==='string'?m.provider:null,model:typeof m.model==='string'?m.model:null};
}
export function matchesManagedModel(result){
 const {provider,model}=actualAgentModel(result);
 return provider===PROVIDER_ID&&(model===MODEL_ID||model===PROVIDER_ID+'/'+MODEL_ID);
}
export async function verifyLocal({dataRoot,request,runAgent,modelStatus,onProgress=()=>{},hardware=()=>({cpu:os.cpus()[0]?.model,ramGiB:Math.round(os.totalmem()/2**30*10)/10,gpu:gpu()})}){
 const root=path.join(dataRoot,'local-inference','verification');
 fs.mkdirSync(root,{recursive:true});
 const report={version:1,checkedAt:new Date().toISOString(),hardware:hardware(),model:MODEL_ID,quant:modelStatus.quant,context:modelStatus.context,benchmarkTokensPerSecond:modelStatus.tps,direct:{status:'pending'},openclaw:{status:'pending'}};
 const publish=()=>{const tmp=path.join(root,'latest.tmp');fs.writeFileSync(tmp,JSON.stringify(report,null,2));fs.renameSync(tmp,path.join(root,'latest.json'));onProgress(structuredClone(report));};
 publish();
 try{
  const nonce=crypto.randomBytes(8).toString('hex'),expected='CALYPSO-'+nonce;
  const started=performance.now();
  const r=await request({model:MODEL_ID,stream:false,options:{num_predict:96},messages:[{role:'user',content:'Reply with only this exact text: '+expected}]},AbortSignal.timeout(120000));
  if(!r.ok)throw Error('Local inference returned HTTP '+r.status);
  const d=await r.json();if(d.error||String(d.message?.content||'').trim()!==expected)throw Error('Local exact-response check failed.');
  const stream=await request({model:MODEL_ID,stream:true,options:{num_predict:96},messages:[{role:'user',content:'Reply with only this exact text: '+expected}]},AbortSignal.timeout(120000));
  if(!stream.ok)throw Error('Local streaming returned HTTP '+stream.status);
  let text='',done=false;
  for(const line of (await stream.text()).split('\n')){if(!line.trim())continue;const chunk=JSON.parse(line);if(chunk.error)throw Error('Local streaming returned an error.');text+=chunk.message?.content||'';done||=chunk.done===true;}
  if(!done||text.trim()!==expected)throw Error('Local streaming exact-response check failed.');
  report.direct={status:'passed',nonStreaming:true,streaming:true,elapsedSeconds:Math.round((performance.now()-started)/100)/10};
 }catch(e){report.direct={status:'failed',error:String(e.message).slice(0,200)};}
 publish();
 if(report.direct.status!=='passed'){report.openclaw={status:'blocked',error:'Direct model verification did not pass.'};publish();return report;}
 if(!runAgent){report.openclaw={status:'blocked',error:'OpenClaw gateway is not available.'};publish();return report;}
 const dir=fs.mkdtempSync(path.join(root,'trial-')),input=path.join(dir,'input.txt'),output=path.join(dir,'output.txt'),promptFile=path.join(dir,'instructions.txt'),nonce=crypto.randomBytes(24).toString('hex');
 try{
  fs.writeFileSync(input,nonce,{flag:'wx'});
  fs.writeFileSync(promptFile,'Calypso local diagnostic only. Use your file read tool to read the exact contents of '+input+'. Use your file write tool to write those exact contents, without modifications, to '+output+'. Only these two paths are authorized. Do not browse, delegate, send messages, execute shell commands, or modify any other files. Reply DONE when the file exists.',{flag:'wx'});
  const result=await runAgent({promptFile,sessionId:crypto.randomUUID()});
  const identity=actualAgentModel(result);
  const filePass=fs.existsSync(output)&&fs.lstatSync(output).isFile()&&!fs.lstatSync(output).isSymbolicLink()&&fs.readFileSync(output,'utf8').trim()===nonce;
  const toolPass=Array.isArray(result?.tools)&&result.tools.some(t=>/^(?:file[_-]?)?read(?:[_-]file)?$/i.test(String(t)))&&result.tools.some(t=>/^(?:file[_-]?)?write(?:[_-]file)?$/i.test(String(t)));
  const modelPass=matchesManagedModel(result);
  report.openclaw={status:result?.ok&&filePass&&toolPass&&modelPass?'passed':'failed',filePass,toolPass,modelPass,provider:identity.provider,model:identity.model};
  if(report.openclaw.status==='failed')report.openclaw.error=!result?.ok?'OpenClaw agent execution failed.':!modelPass?'OpenClaw did not prove the requested local provider and model were used.':!filePass?'The expected test file was not created correctly.':'OpenClaw did not return both successful file-tool receipts.';
 }catch{report.openclaw={status:'failed',error:'OpenClaw diagnostic could not complete.'};}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
 publish();return report;
}
