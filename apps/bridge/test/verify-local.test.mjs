import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyLocal,matchesManagedModel} from '../verify-local.mjs';
test('requires exact local model provenance',()=>{
 const receipt=(provider,model)=>({data:{result:{meta:{agentMeta:{provider,model}}}}});
 assert.equal(matchesManagedModel(receipt('calypso-llama','calypso-35b')),true);
 assert.equal(matchesManagedModel(receipt('openai','calypso-35b')),false);
 assert.equal(matchesManagedModel({ok:true}),false);
});
test('checks both local inference modes, actual file, tool receipts and provider identity',async t=>{
 const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'calypso-verify-'));t.after(()=>fs.rmSync(dataRoot,{recursive:true,force:true}));
 const request=async b=>{const content=b.messages[0].content.split(': ').at(-1);return b.stream?new Response(JSON.stringify({message:{content},done:true})+'\n'):Response.json({message:{content}});};
 const runAgent=async({promptFile})=>{const prompt=fs.readFileSync(promptFile,'utf8');const input=prompt.match(/contents of (.+?input\.txt)/)[1],output=prompt.match(/to (.+?output\.txt)/)[1];fs.copyFileSync(input,output);return {ok:true,tools:['read','write'],data:{result:{meta:{agentMeta:{provider:'calypso-llama',model:'calypso-35b'}}}}};};
 const report=await verifyLocal({dataRoot,request,runAgent,modelStatus:{tps:12},hardware:()=>({})});
 assert.equal(report.direct.status,'passed');assert.equal(report.openclaw.status,'passed');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot,'local-inference','verification','latest.json'),'utf8')).openclaw.status,'passed');
 const bad=await verifyLocal({dataRoot,request,runAgent:async()=>({ok:true,tools:['read','write']}),modelStatus:{},hardware:()=>({})});
 assert.equal(bad.openclaw.status,'failed');
 const blocked=await verifyLocal({dataRoot,request:async()=>Response.json({message:{content:'wrong'}}),runAgent,modelStatus:{},hardware:()=>({})});
 assert.equal(blocked.direct.status,'failed');assert.equal(blocked.openclaw.status,'blocked');
});
