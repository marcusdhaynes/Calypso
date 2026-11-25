import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eligible,providerConfig,openAIAsOllama,MODEL_ID} from '../managed-llama.mjs';
test('optimized route supports 16 GiB Windows laptop and avoids unsupported platforms',()=>{
 const hw={platform:'win32',arch:'x64',ramGiB:15.7,device:{totalMiB:8192}};
 assert.equal(eligible(hw),true);assert.equal(eligible({...hw,ramGiB:8}),false);assert.equal(eligible({...hw,platform:'linux'}),false);
});
test('OpenClaw provider uses only authenticated localhost and zero costs',()=>{
 const p=providerConfig('secret');assert.equal(p.baseUrl,'http://127.0.0.1:18792/v1');assert.equal(p.models[0].id,MODEL_ID);assert.equal(p.models[0].cost.output,0);assert.equal(p.apiKey,'secret');
});
test('nonstream response preserves content and length termination',async()=>{
 const r=await openAIAsOllama(Response.json({choices:[{message:{content:'Hello'},finish_reason:'length'}]}),false);
 assert.deepEqual(await r.json(),{message:{content:'Hello'},done_reason:'length'});
});
test('SSE adapter ignores reasoning, streams only content, and completes',async()=>{
 const r=await openAIAsOllama(new Response('data: {"choices":[{"delta":{"reasoning_content":"secret"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),true);
 const text=await r.text();assert.match(text,/Hello/);assert.match(text,/"done":true/);assert.doesNotMatch(text,/secret/);
});

test('provider context describes the actual selected context',()=>{assert.equal(providerConfig('test',16384).models[0].contextWindow,16384);});
