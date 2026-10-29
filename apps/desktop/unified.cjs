const {app,BrowserWindow,shell,Tray,Menu}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
let bridge,window,tray,quitting=false;
app.whenReady().then(async()=>{
 const bridgePath=app.isPackaged?path.join(process.resourcesPath,'calypso-bridge','server.mjs'):path.resolve(__dirname,'../bridge/server.mjs');
 const webRoot=app.isPackaged?path.join(process.resourcesPath,'calypso-web'):path.resolve(__dirname,'../web');
 const {createCalypso}=await import(pathToFileURL(bridgePath).href);
 let origin='http://127.0.0.1:18791',existing=false;try{existing=(await fetch(origin+'/health',{signal:AbortSignal.timeout(900)})).ok;}catch{}
 if(!existing){bridge=createCalypso({webRoot});const address=await bridge.listen(18791);origin=`http://127.0.0.1:${address.port}`;}
 window=new BrowserWindow({width:1440,height:940,minWidth:420,minHeight:650,backgroundColor:'#0b1017',title:'Calypso',autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const trayPath=app.isPackaged?path.join(process.resourcesPath,'tray-icon.png'):path.join(__dirname,'resources/tray-icon.png');
 tray=new Tray(trayPath);tray.setToolTip('Calypso · local agent engine');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Calypso',click:()=>{window.show();window.focus();}},{type:'separator'},{label:'Quit Calypso',click:()=>app.quit()}]));tray.on('double-click',()=>window.show());
 window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
 window.webContents.setWindowOpenHandler(({url})=>{const target=new URL(url);if(['http:','https:'].includes(target.protocol))shell.openExternal(url);return {action:'deny'};});
 window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/')){event.preventDefault();if(/^https?:/.test(url))shell.openExternal(url);}});
 await window.loadURL(origin);
});
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{if(!quitting){event.preventDefault();quitting=true;Promise.resolve(bridge?.close()).finally(()=>app.quit());}});
