import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePlan,understand,createResponse} from '../understanding.mjs';
import {webSearchPlan} from '../server.mjs';

const plan=parsePlan({mode:'create',subject:'Donquixote Doflamingo, One Piece',goal:'Complete video essay script',research:true,queries:['Doflamingo One Piece character','Doflamingo Dressrosa themes']});
const messages=[{role:'user',content:'Write a video essay about why Doflamingo is one of the greatest villains.'}];
test('interpretation repairs malformed output and retains resolved context without a character lookup table',async()=>{
 let calls=0;
 const p=await understand({messages,complete:async m=>{calls++;assert.equal(m[1].content,messages[0].content);return calls===1?'invalid':JSON.stringify(plan);}});
 assert.equal(p.subject,plan.subject);assert.equal(calls,2);
});
test('clarification choices are bounded and invalid ambiguous plans are rejected',()=>{
 assert.throws(()=>parsePlan({mode:'clarify',subject:'ambiguous',question:'Which?',choices:['only one']}));
 assert.deepEqual(parsePlan({mode:'clarify',subject:'ambiguous',question:'Which?',choices:['A','A','B','C','D']}).choices,['A','B','C']);
});
test('research gathers distinct evidence then revises the whole deliverable on failed review',async()=>{
 const queries=[],statuses=[];let calls=0;
 const result=await createResponse({plan,messages,onStatus:s=>statuses.push(s),lookup:async q=>{queries.push(q);return {sources:[{title:'Character reference',url:'https://example.org/character',summary:'Evidence excerpt'}]};},complete:async(m,o)=>{
  calls++;assert.match(m[0].content,/Evidence excerpt/);
  return ['Draft with unsupported quotation',JSON.stringify({pass:false,issues:['Remove the unsupported quotation']}),'Corrected full script',JSON.stringify({pass:true,issues:[]})][calls-1];
 }});
 assert.deepEqual(queries,plan.queries);assert.equal(result.sources.length,1);assert.equal(result.content,'Corrected full script');assert.equal(result.reviewPassed,true);assert.equal(calls,4);assert.ok(statuses.some(s=>s.includes('Correcting')));
});
test('failed research remains explicit and never becomes a fact-checked result',async()=>{
 const result=await createResponse({plan,messages,lookup:async()=>{throw Error('offline');},complete:async(m,o)=>o.json?'{"pass":true,"issues":[]}':'Provisional script'});
 assert.equal(result.verificationIncomplete,true);assert.equal(result.sources.length,0);assert.equal(result.failures.length,2);
});
test('review retries are bounded and malformed verdicts cannot count as passing',async()=>{
 let calls=0;
 const result=await createResponse({plan:{...plan,research:false},messages,lookup:async()=>assert.fail(),complete:async(m,o)=>{calls++;return o.json?'invalid review':'Draft';}});
 assert.equal(calls,6);assert.equal(result.reviewPassed,false);
});
test('pure creative work skips research and respects cancellation during lookup',async()=>{
 const result=await createResponse({plan:{...plan,research:false},messages,lookup:async()=>assert.fail(),complete:async(m,o)=>o.json?'{"pass":true,"issues":[]}':'Original poem'});
 assert.equal(result.verificationIncomplete,false);
 const controller=new AbortController();controller.abort(Error('User stopped'));
 await assert.rejects(createResponse({plan,messages,signal:controller.signal,lookup:async()=>{throw Error('aborted');},complete:async()=>assert.fail()}),/User stopped/);
});
test('fiction evidence queries do not become recent obituary feeds',()=>{
 const p=webSearchPlan('Dresden Files character death',{generalSearch:true});
 assert.equal(p.news,false);assert.equal(p.death,false);assert.match(p.urls[0],/bing.com\/search/);
});

test('saved context reaches subject interpretation before any drafting',async()=>{
 let prompt='';
 await understand({messages,context:'Videos refer to the novels, not the TV adaptation; avoid spoilers after book three.',complete:async m=>{prompt=m[0].content;return JSON.stringify(plan);}});
 assert.match(prompt,/avoid spoilers after book three/);
});
test('null review verdicts fail safely and trigger bounded correction',async()=>{
 let calls=0;
 const result=await createResponse({plan:{...plan,research:false},messages,lookup:async()=>assert.fail(),complete:async(m,o)=>{calls++;return o.json?'null':'Draft';}});
 assert.equal(result.reviewPassed,false);assert.equal(calls,6);
});
test('malformed search entries do not prevent useful sources from being used',async()=>{
 let i=0;
 const result=await createResponse({plan,messages,lookup:async()=>++i===1?null:{sources:[null,{url:'javascript:alert(1)'},{title:'Valid',url:'https://example.org/source',summary:'Evidence'}]},complete:async(m,o)=>o.json?'{"pass":true,"issues":[]}':'Draft'});
 assert.equal(result.sources.length,1);assert.equal(result.sources[0].title,'Valid');assert.equal(result.failures.length,1);
});
