import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planModels,createAutoModel} from '../auto-model.mjs';
test('hardware planning prioritizes largest practical models and reserves disk space',()=>{
 const plan=(ramGiB,diskBytes=200e9,installed=[])=>planModels({ramGiB,diskBytes,installed}).map(x=>x.id);
 assert.equal(plan(32)[0],'qwen3.6:35b-a3b');
 assert.equal(plan(64)[0],'qwen3.6:35b-a3b');
 assert.equal(plan(96)[0],'gpt-oss:120b');
 assert.equal(plan(128)[0],'qwen3.5:122b');
 assert.notEqual(plan(16)[0],'qwen3.6:35b-a3b');
 assert.equal(plan(32,0,['qwen3.6:35b-a3b'])[0],'qwen3.6:35b-a3b');
 assert.equal(plan(32,0).length,0);
});
test('downloads a 35B model, verifies tool calling and speed, and activates it',async()=>{
 let names=[],requests=[];
 const fetcher=async(url,req)=>{
  const route=new URL(url).pathname,body=req.body?JSON.parse(req.body):null;requests.push({route,body});
  if(route==='/api/tags')return Response.json({models:names.map(name=>({name,size:23e9}))});
  if(route==='/api/pull'){names.push(body.model);return new Response('{"status":"success"}\n');}
  if(body.tools)return Response.json({message:{tool_calls:[{function:{name:'ping',arguments:{value:42}}}]}});
  return Response.json({message:{content:'Rain forms when vapor cools.'},eval_count:20,eval_duration:1e9});
 };
 const setup=createAutoModel({fetcher,startRuntime:false,hardware:()=>({ramGiB:32,diskBytes:100e9})});
 assert.equal(await setup.start(),'qwen3.6:35b-a3b');
 assert.equal(setup.status.phase,'ready');assert.equal(setup.status.tps,20);
 assert.equal(requests.filter(x=>x.route==='/api/pull').length,1);
 setup.close();
});
test('rejects slow candidates and selects a faster verified smaller model',async()=>{
 let names=['qwen3.6:35b-a3b','qwen3.5:35b'];
 const fetcher=async(url,req)=>{
  const route=new URL(url).pathname,body=req.body?JSON.parse(req.body):null;
  if(route==='/api/tags')return Response.json({models:names.map(name=>({name,size:23e9}))});
  if(route==='/api/generate')return Response.json({});
  if(body.tools)return Response.json({message:{tool_calls:[{function:{name:'ping',arguments:{value:42}}}]}});
  return Response.json({message:{content:'Rain forms.'},eval_count:body.model==='qwen3.6:35b-a3b'?2:20,eval_duration:1e9});
 };
 const setup=createAutoModel({fetcher,startRuntime:false,hardware:()=>({ramGiB:32,diskBytes:0})});
 assert.equal(await setup.start(),'qwen3.5:35b');
 setup.close();
});
