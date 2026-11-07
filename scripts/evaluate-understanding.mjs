import fs from 'node:fs';
import {understand,createResponse} from '../apps/bridge/understanding.mjs';
import {lookupWeb,visibleStream} from '../apps/bridge/server.mjs';

const model=process.env.CALYPSO_EVAL_MODEL||'qwen3.5:4b';
const group=process.env.CALYPSO_EVAL_GROUP||'interpretation';
const controller=new AbortController();
const deadline=setTimeout(()=>controller.abort(Error('Evaluation deadline exceeded')),25*60*1000);
const report={model,group,startedAt:new Date().toISOString(),cases:[],limitations:'Real local-model inference and live search. Structural checks are not a guarantee of factual accuracy; inspect the saved answers and sources.'};
const complete=async(messages,{json=false,tokens=4000,signal}={})=>{
 const start=Date.now();
 const r=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,stream:false,think:false,format:json?'json':undefined,keep_alive:'30m',options:{num_ctx:32768,num_predict:tokens,seed:42}}),signal:signal||controller.signal});
 if(!r.ok)throw Error((await r.text()).slice(0,600));
 const d=await r.json();if(d.error)throw Error(d.error);
 console.log(JSON.stringify({event:'model_call',seconds:(Date.now()-start)/1000,tokens:d.eval_count,doneReason:d.done_reason}));
 if(d.done_reason==='length')throw Error('Model output truncated at token limit');
 const content=visibleStream().push(d.message?.content||'',true);
 if(!content.trim())throw Error('Empty model response');
 return content;
};
const scenarios=[
 {id:'doflamingo',groups:['interpretation','doflamingo'],prompt:'Write a 500-word video essay script arguing why Doflamingo is one of the greatest villains ever written. Include a hook, a clear thesis, two concrete examples, a serious counterargument, and a conclusion. Distinguish interpretation from canon. Do not invent quotations or chapter numbers.',subject:/one piece/i},
 {id:'dresden',groups:['interpretation','dresden'],prompt:'Create exactly six distinct Dresden Files video ideas for a channel aimed at new readers. No spoilers beyond Storm Front. Number them 1 through 6. For each give a title, opening hook, central argument, spoiler boundary, factual evidence needed, and an audience-appeal hypothesis. Do not invent YouTube view counts or claim the ideas are guaranteed to go viral.',subject:/dresden/i},
 {id:'ambiguous-mercury',groups:['interpretation'],prompt:'Write a detailed explainer about Mercury.',clarify:true},
 {id:'context-followup',groups:['interpretation'],history:[{role:'user',content:'We are making videos about Jim Butcher’s Dresden Files novels, for readers who finished only Storm Front.'},{role:'assistant',content:'I will keep the discussion to Storm Front and distinguish the novels from the TV adaptation.'}],prompt:'Now give me six more ideas with stronger hooks, keeping that spoiler limit.',subject:/dresden/i},
 {id:'provided-material',groups:['interpretation'],prompt:'Using only these invented facts, write a 200-word dramatic story without browsing: Mira is a lighthouse keeper; the sea has vanished overnight; a bell rings underground.',noResearch:true}
];
try{
 const tags=await(await fetch('http://127.0.0.1:11434/api/tags')).json();
 report.installedModel=tags.models?.find(m=>m.name===model);
 for(const scenario of scenarios.filter(s=>s.groups.includes(group))){
  const item={id:scenario.id,prompt:scenario.prompt,checks:[]};report.cases.push(item);
  const messages=[...(scenario.history||[]),{role:'user',content:scenario.prompt}];
  console.log(JSON.stringify({event:'case_started',id:scenario.id}));
  try{
   const plan=await understand({messages,complete,signal:controller.signal});item.plan=plan;
   if(scenario.subject)item.checks.push({name:'Resolves intended subject',pass:scenario.subject.test(plan.subject+' '+plan.goal)});
   if(scenario.clarify)item.checks.push({name:'Asks about genuine ambiguity with choices',pass:plan.mode==='clarify'&&plan.choices.length>=2});
   else item.checks.push({name:'Does not ask unnecessary clarification',pass:plan.mode!=='clarify'});
   if(scenario.noResearch)item.checks.push({name:'Respects supplied-material-only instruction',pass:plan.research===false});
   if(group!=='interpretation'&&plan.mode!=='clarify'){
    const result=await createResponse({plan,messages,complete,lookup:(q,signal)=>lookupWeb(q,signal,fetch,{generalSearch:true}),signal:controller.signal,onStatus:status=>console.log(JSON.stringify({event:'progress',id:scenario.id,status}))});
    item.result=result;
    item.checks.push({name:'Research found evidence',pass:!result.verificationIncomplete&&result.sources.length>0},{name:'Model review passed',pass:result.reviewPassed},{name:'Substantial completed answer',pass:result.content.split(/\s+/).length>=300});
   }
   item.passed=item.checks.every(c=>c.pass);
  }catch(e){item.error=e.message;item.passed=false;}
  console.log('CALYPSO_EVAL_CASE '+JSON.stringify(item));
 }
}catch(e){report.error=e.message;}finally{
 clearTimeout(deadline);report.finishedAt=new Date().toISOString();
 report.passed=!report.error&&report.cases.length>0&&report.cases.every(c=>c.passed);
 fs.mkdirSync('evaluation-results',{recursive:true});
 fs.writeFileSync('evaluation-results/'+group+'.json',JSON.stringify(report,null,2));
 const summary='# Calypso live model evaluation: '+group+'\n\nModel: '+model+'\n\n'+report.cases.map(c=>'- '+c.id+': '+(c.passed?'structural checks passed':'FAILED')+(c.error?' — '+c.error:'')).join('\n')+'\n\n'+report.limitations+'\n';
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
 console.log('CALYPSO_EVAL_SUMMARY '+JSON.stringify({group,passed:report.passed,error:report.error,cases:report.cases.map(c=>({id:c.id,passed:c.passed,error:c.error,checks:c.checks}))}));
 process.exitCode=report.passed?0:1;
}
