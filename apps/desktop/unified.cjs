const {app,BrowserWindow,shell,Tray,Menu}=require('electron');
const path=require('node:path');
const {spawn}=require('node:child_process');
let bridge,window,tray,quitting=false;
app.whenReady().then(async()=>{
 const bridgePath=app.isPackaged?path.join(process.resourcesPath,'calypso-bridge','supervisor.mjs'):path.resolve(__dirname,'../bridge/supervisor.mjs');
 const webRoot=app.isPackaged?path.join(process.resourcesPath,'calypso-web'):path.resolve(__dirname,'../web');
 
 let origin='http://127.0.0.1:18791',existing=false;try{existing=(await fetch(origin+'/health',{signal:AbortSignal.timeout(900)})).ok;}catch{}
 if(!existing){bridge=spawn(process.execPath,[bridgePath],{windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',CALYPSO_WEB_ROOT:webRoot}});bridge.on('error',e=>console.error(e.message));for(let i=0;i<120;i++){try{if((await fetch(origin+'/health',{signal:AbortSignal.timeout(500)})).ok){existing=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}if(!existing)throw Error('Calypso local engine could not start.');}
 window=new BrowserWindow({width:1440,height:940,minWidth:420,minHeight:650,backgroundColor:'#0b1017',title:'Calypso',autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const trayPath=app.isPackaged?path.join(process.resourcesPath,'tray-icon.png'):path.join(__dirname,'resources/tray-icon.png');
 tray=new Tray(trayPath);tray.setToolTip('Calypso · local agent engine');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Calypso',click:()=>{window.show();window.focus();}},{type:'separator'},{label:'Quit Calypso',click:()=>app.quit()}]));tray.on('double-click',()=>window.show());
 window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
 window.webContents.setWindowOpenHandler(({url})=>{const target=new URL(url);if(['http:','https:'].includes(target.protocol))shell.openExternal(url);return {action:'deny'};});
 window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/')){event.preventDefault();if(/^https?:/.test(url))shell.openExternal(url);}});
 await window.loadURL(origin);
});
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{if(!quitting){event.preventDefault();quitting=true;if(bridge&&!bridge.killed){bridge.kill();}app.quit();}});
