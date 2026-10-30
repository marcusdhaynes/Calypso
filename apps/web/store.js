const KEY='calypso.workspace.v2',ENDPOINT='http://127.0.0.1:18791';
const id=()=>crypto.randomUUID(),at=()=>new Date().toISOString();
const seed=()=>({version:2,revision:0,workers:[['coordinator','Calypso','coordinator','Scope the project and organize the crew.'],['researcher','Scout','researcher','Gather evidence and compare possibilities.'],['writer','Maker','writer','Build useful, verified deliverables.'],['reviewer','Lens','reviewer','Independently check the results.']].map(([id,name,role,instructions])=>({id,name,role,instructions,engine:'local',createdAt:at()})),teams:[{id:'default',name:'Calypso crew',description:'A small, focused team for big ideas.',workerIds:['coordinator','researcher','writer','reviewer']}],projects:[],conversations:[],routines:[],memories:[],settings:{model:'',theme:'dark',freeOnly:true,speech:false},activity:[]});
let local;try{local=JSON.parse(localStorage.getItem(KEY))||seed();}catch{local=seed();}
export const workspace={state:local,connected:false,status:null,base:location.hostname==='127.0.0.1'||location.hostname==='localhost'?location.origin:ENDPOINT,token:sessionStorage.getItem('calypso.bridge.token')||'',bridgeReachable:false,connectionIssue:null,connectionError:'',failedRefreshes:0,listeners:new Set()};
function saveLocal(){local.revision++;localStorage.setItem(KEY,JSON.stringify(local));}
export function subscribe(fn){workspace.listeners.add(fn);return()=>workspace.listeners.delete(fn);}
function emit(){for(const fn of workspace.listeners)fn();}
export async function request(route,body){const r=await fetch(workspace.base+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(workspace.token?{Authorization:'Bearer '+workspace.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(route==='/api/action'?200000:5000)});const d=await r.json();if(!r.ok){const error=new Error(d.error||'Local workspace request failed');error.status=r.status;throw error;}return d;}
export async function connect(){
 // Probe the bridge separately from its authenticated workspace: running is not paired.
 try{await request('/health');workspace.bridgeReachable=true;}
 catch(error){workspace.connected=false;workspace.bridgeReachable=false;workspace.connectionIssue='unreachable';workspace.connectionError=error.message;workspace.state=local;emit();return false;}
 try{
  const remote=await request('/api/state');
  workspace.connected=true;workspace.connectionIssue=null;workspace.connectionError='';workspace.failedRefreshes=0;workspace.state=remote;emit();
  // Ollama may be starting or busy: status/model discovery must not invalidate a valid connection.
  request('/api/status').then(status=>{if(workspace.connected){workspace.status=status;emit();}}).catch(()=>{});
  return true;
 }catch(error){
  workspace.connected=false;workspace.connectionIssue=error.status===401?'pairing':error.status===403?'permission':'temporary';
  workspace.connectionError=error.message;workspace.state=local;emit();return false;
 }
}
export async function refresh(){
 if(!workspace.connected)return;
 try{const s=await request('/api/state?revision='+workspace.state.revision);workspace.failedRefreshes=0;if(!s.unchanged){workspace.state=s;emit();}}
 catch(error){
  if(error.status===401||error.status===403){workspace.connected=false;workspace.connectionIssue=error.status===401?'pairing':'permission';workspace.connectionError=error.message;workspace.state=local;emit();return;}
  // A single timeout or busy system is not a disconnection. Recheck after repeated failures.
  if(++workspace.failedRefreshes>=3)await connect();
 }
}
export async function importDrafts(){if(!workspace.connected)throw Error('Connect your computer first.');const result=await request('/api/action',{type:'workspace.import',data:{workers:local.workers,projects:local.projects,memories:local.memories}});await refresh();return result;}
let pairingPopup=null,pairingCallbacks=[],pairingListener=null,pairingWatch=null;
export function pair(onConnected){
 if(location.origin===workspace.base)return connect().then(ok=>{if(ok)onConnected?.();return ok;});
 if(pairingPopup&&!pairingPopup.closed){if(onConnected&&!pairingCallbacks.length)pairingCallbacks.push(onConnected);pairingPopup.focus();return;}
 if(pairingListener)window.removeEventListener('message',pairingListener);
 if(pairingWatch)clearInterval(pairingWatch);
 pairingCallbacks=onConnected?[onConnected]:[];
 const popup=window.open(workspace.base+'/pair?origin='+encodeURIComponent(location.origin),'calypso-pair','width=580,height=560');
 if(!popup){pairingCallbacks=[];throw Error('Allow the Calypso pairing window to open, or use the local app.');}
 pairingPopup=popup;
 const cleanup=()=>{window.removeEventListener('message',pairingListener);clearInterval(pairingWatch);pairingListener=null;pairingWatch=null;pairingPopup=null;};
 pairingListener=async e=>{
  if(e.origin!==workspace.base||e.source!==popup||e.data?.type!=='calypso-paired'||typeof e.data.token!=='string')return;
  cleanup();workspace.token=e.data.token;sessionStorage.setItem('calypso.bridge.token',workspace.token);
  const ok=await connect();const callbacks=pairingCallbacks.splice(0);
  if(ok)for(const cb of callbacks)cb();
  else window.dispatchEvent(new CustomEvent('calypso-pair-error',{detail:workspace.connectionError||'Pairing could not be verified.'}));
  popup.close();
 };
 window.addEventListener('message',pairingListener);
 pairingWatch=setInterval(()=>{if(popup.closed){cleanup();pairingCallbacks=[];}},1000);
}
// Project-only launch is trusted to this app's publisher origin. General local
// APIs still require pairing; this endpoint returns only the selected project ID.
export async function launchLocally(project,projectAction='resume',instructions=''){
 const response=await fetch(ENDPOINT+'/api/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,action:projectAction,instructions,workers:local.workers.filter(w=>project.workerIds.includes(w.id))}),signal:AbortSignal.timeout(15000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'The local engine is starting. Try Start again shortly.');project.remoteId=result.projectId;saveLocal();location.assign(ENDPOINT+'/#project='+encodeURIComponent(result.projectId));return project;
}
export async function action(type,b={}){
 if(workspace.connected){const result=await request('/api/action',{type,data:b});await refresh();return result;}
 let result;
 if(type==='project.create'){if(!b.name?.trim()||!b.description?.trim())throw Error('Name the project and describe the outcome.');const team=b.teamId?local.teams.find(t=>t.id===b.teamId):null;const ids=team?.workerIds||b.workerIds||[];const workers=local.workers.filter(w=>ids.includes(w.id));if(!workers.length)throw Error('Choose at least one agent.');const order=['coordinator','researcher','writer','reviewer'];workers.sort((a,b)=>order.indexOf(a.role)-order.indexOf(b.role));result={...b,id:id(),status:'draft',createdAt:at(),updatedAt:at(),workerIds:workers.map(w=>w.id),tasks:workers.map((w,i)=>({id:'phase-'+(i+1),workerId:w.id,workerName:w.name,role:w.role,title:{coordinator:'Plan & organize',researcher:'Research & discover',writer:'Build & create',reviewer:'Review & verify'}[w.role],status:'queued'})),events:[{at:at(),text:'Draft saved on this device. Connect your computer to run the team.'}]};local.projects.unshift(result);}
 else if(type==='worker.create'){if(!b.name?.trim()||!['coordinator','researcher','writer','reviewer'].includes(b.role))throw Error('Choose a name and role.');const workerId=b.id||b.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');if(!/^[a-z][a-z0-9-]{1,39}$/.test(workerId)||local.workers.some(w=>w.id===workerId))throw Error('Choose a unique ID with 2–40 lowercase letters, numbers or hyphens.');result={...b,id:workerId,engine:'local',createdAt:at()};local.workers.push(result);}
 else if(type==='worker.update'){result=local.workers.find(w=>w.id===b.id);if(!result)throw Error('Agent not found');Object.assign(result,{name:b.name||result.name,instructions:b.instructions??result.instructions,role:b.role||result.role});}
 else if(type==='team.save'){if(!b.name?.trim()||!b.workerIds?.length)throw Error('Name the team and choose its agents.');result={...b,id:b.id||id(),createdAt:at()};const i=local.teams.findIndex(t=>t.id===result.id);if(i>=0)local.teams[i]=result;else local.teams.push(result);}
 else if(type==='conversation.create'){const team=local.teams.find(t=>t.id===b.teamId);result=team?.conversationId?local.conversations.find(c=>c.id===team.conversationId):null;if(!result){result={id:id(),title:team?.name||'New conversation',teamId:team?.id,workerId:b.workerId||team?.workerIds[0]||local.workers[0].id,messages:[],createdAt:at()};local.conversations.unshift(result);if(team)team.conversationId=result.id;}}
 else if(type==='routine.save'){if(!b.name?.trim()||!b.description?.trim()||!b.workerIds?.length||Number(b.minutes)<5)throw Error('Enter a name, task, agents, and an interval of at least 5 minutes.');result={...b,id:b.id||id(),enabled:false,minutes:Number(b.minutes),createdAt:at()};const i=local.routines.findIndex(r=>r.id===result.id);if(i>=0)local.routines[i]=result;else local.routines.unshift(result);}
 else if(type==='routine.toggle')throw Error('Connect the local app to enable scheduled work.');
 else if(type==='routine.delete'){local.routines=local.routines.filter(r=>r.id!==b.id);result={ok:true};}
 else if(type==='memory.save'){if(!b.content?.trim())throw Error('Enter a memory.');result={...b,id:b.id||id(),createdAt:at()};const i=local.memories.findIndex(m=>m.id===result.id);if(i>=0)local.memories[i]=result;else local.memories.push(result);}
 else if(type==='memory.delete'){local.memories=local.memories.filter(m=>m.id!==b.id);result={ok:true};}
 else if(type==='settings.update'){if(b.freeOnly===false||b.cloudModelsEnabled||b.apiKey||b.baseUrl)throw Error('Only free local models are allowed.');Object.assign(local.settings,{theme:b.theme||local.settings.theme,speech:b.speech??local.settings.speech,freeOnly:true});result=local.settings;}
 else if(type==='project.action'){const p=local.projects.find(p=>p.id===b.id);if(!p)throw Error('Project not found.');return launchLocally(p,b.action,b.instructions||'');}
 else throw Error('This feature needs your local computer. Connect Calypso to continue.');
 saveLocal();workspace.state=local;emit();if(type==='project.create'&&b.start!==false)return launchLocally(result);return result;
}
export async function chat(conversationId,text,onDelta,signal,workerId,onEvent=()=>{}){if(!workspace.connected)throw Error('Connect your computer to chat with a free local model.');const r=await fetch(workspace.base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',...(workspace.token?{Authorization:'Bearer '+workspace.token}:{})},body:JSON.stringify({conversationId,text,workerId}),signal});if(!r.ok){const d=await r.json();throw Error(d.error);}let buf='';const decoder=new TextDecoder();for await(const chunk of r.body){buf+=decoder.decode(chunk,{stream:true});let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(line){const d=JSON.parse(line);if(d.error)throw Error(d.error);if(d.status||d.search||d.sources)onEvent(d);if(d.delta)onDelta(d.delta);}}}await refresh();}
export function exportWorkspace(){return JSON.stringify(workspace.state,null,2);}
export function localDraftCount(){return local.projects.filter(p=>p.status==='draft').length;}
