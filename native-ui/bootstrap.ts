import type { Config, RuntimeStatus } from './types';
declare global {
  interface Window {
    __TAURI_INTERNALS__: { invoke<T>(command:string,args?:Record<string,unknown>):Promise<T> };
    __KAWAICORD_BOOT__: { activeMod:RuntimeStatus['activeMod']; safeMode:boolean;config:Config;version:string;platform:string };
    __kawaicordNativeStart?: (css:string)=>void;
    __kawaicordSetBackground?: (background:boolean)=>void;
    Vencord?: { Webpack?: {cache?: Record<string,unknown>; findByProps?: (...props:string[])=>any}; Settings?:any };
    shelter?: unknown;
    kawaicord: {restart:()=>Promise<void>; reload:()=>Promise<void>;openSettings:()=>Promise<void>;version:()=>Promise<string>;isKawaicord:true;platform:string};
  }
}
// capture only the bridge needed by this page. no filesystem, process spawning,
// shell, or updater commands are granted to the remote discord webview.
const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
const boot=window.__KAWAICORD_BOOT__;
window.kawaicord=Object.freeze({
  restart:()=>invoke<void>('restart_app'),reload:()=>invoke<void>('reload_discord'),
  openSettings:()=>invoke<void>('open_settings'),version:()=>Promise.resolve(boot.version),
  isKawaicord:true as const,platform:boot.platform
});
let background=false;
window.__kawaicordSetBackground=(hidden:boolean)=>{
  background=hidden;
  if(document.documentElement)document.documentElement.dataset.kawaicordBackground=String(hidden&&boot.config.performanceMode);
};
function style(css:string){const sheet=document.createElement('style');sheet.textContent=css;document.head.append(sheet);}
function mounted(fn:()=>void){ if(document.head&&document.body)fn();else document.addEventListener('DOMContentLoaded',fn,{once:true}); }
let lastUnread=-1;
function updateUnread(){
  const count=Number(/^\((\d+)\)/.exec(document.title)?.[1]??0);
  if(count!==lastUnread){lastUnread=count;void invoke('set_unread',{count}).catch(()=>{});}
}
mounted(()=>{
  style('html[data-kawaicord-background="true"] *,html[data-kawaicord-background="true"] *::before,html[data-kawaicord-background="true"] *::after{animation-play-state:paused!important;transition-duration:0s!important}html[data-kawaicord-background="true"] #app-mount img{visibility:hidden!important}');
  window.__kawaicordSetBackground?.(background);
  const title=document.querySelector('title');if(title)new MutationObserver(updateUnread).observe(title,{childList:true,subtree:true,characterData:true});updateUnread();
  // settings always remain reachable if a client mod fails to initialize.
  const host=document.createElement('div');host.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647';
  const shadow=host.attachShadow({mode:'closed'});const button=document.createElement('button');button.textContent='Kawaicord';
  button.style.cssText='font:12px system-ui;padding:7px 11px;border-radius:8px;background:#24202f;color:#e8defb;border:1px solid #64507d;cursor:pointer';
  button.onclick=()=>void window.kawaicord.openSettings();shadow.append(button);document.body.append(host);
});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='r'||event.key==='F5'){
    event.preventDefault();void window.kawaicord.reload();
  }
  if((event.ctrlKey||event.metaKey)&&event.key===','){event.preventDefault();void window.kawaicord.openSettings();}
});
window.__kawaicordNativeStart=(css:string)=>{
  if(!boot.safeMode)mounted(()=>style(css));
  const started=performance.now();
  let checking=false;let done=false;
  const timer=window.setInterval(check,500);
  const observer=new MutationObserver(()=>{if(!checking){checking=true;queueMicrotask(()=>{checking=false;check();});}});
  observer.observe(document,{childList:true,subtree:true});
  function check(){
    if(done)return;
    const modules=Object.keys(window.Vencord?.Webpack?.cache??{}).length;
    const root=document.getElementById('app-mount');
    const mounted=!!root&&(root.textContent?.trim().length??0)>10;
    const ready=!!window.shelter&&(boot.safeMode||modules>100)&&mounted;
    if(!ready&&performance.now()-started<60000)return;
    done=true;clearInterval(timer);observer.disconnect();
    const status:RuntimeStatus={activeMod:boot.activeMod,safeMode:boot.safeMode,shelter:!!window.shelter,modules,ready,
      media:typeof navigator.mediaDevices?.getUserMedia==='function',screenSharing:typeof navigator.mediaDevices?.getDisplayMedia==='function',
      error:ready?null:'Discord or the selected mod did not finish initializing. Reload or open Kawaicord settings to try recovery mode.',version:boot.version,platform:boot.platform};
    void invoke('report_runtime',{status}).catch(console.error);
  }
  check();
};
export {};
// preserve the connection in webviews that otherwise freeze a hidden page.
// a pending web lock uses no polling timer and is released on navigation.
if(navigator.locks)void navigator.locks.request('kawaicord-live',()=>new Promise<void>(resolve=>window.addEventListener('pagehide',()=>resolve(),{once:true}))).catch(()=>{});
(window as any).__kawaicordUpdateConfig=(config:Config)=>{Object.assign(boot.config,config);window.__kawaicordSetBackground?.(background);};
(window as any).__kawaicordActivity=async(data:any)=>{
  const webpack:any=window.Vencord?.Webpack;
  const common=webpack?.Common;
  if(!common?.FluxDispatcher||(!boot.config.richPresence&&data.activity))return;
  const activity=data.activity;
  if(activity){
    const appId=activity.application_id;
    try{
      const assetUtils=common.ApplicationAssetUtils;
      for(const size of ['large_image','small_image'])if(activity.assets?.[size]&&assetUtils)activity.assets[size]=(await assetUtils.fetchAssetIds(appId,[activity.assets[size]]))[0];
      if(!activity.name){const response=await fetch(`https://discord.com/api/v9/applications/${encodeURIComponent(appId)}/rpc`);if(response.ok)activity.name=(await response.json()).name;}
    }catch{}
  }
  common.FluxDispatcher.dispatch({type:'LOCAL_ACTIVITY_UPDATE',...data});
};
// notification delivery belongs to the native host, not an extra renderer.
if(boot.config.notifications){
  let permission:NotificationPermission='default';
  void invoke<string>('notification_permission',{request:false}).then(p=>{permission=p==='granted'?'granted':p==='denied'?'denied':'default';}).catch(()=>{});
  class NativeNotification extends EventTarget{
    static get permission(){return permission;}
    static async requestPermission(callback?:(permission:NotificationPermission)=>void){const p=await invoke<string>('notification_permission',{request:true});permission=p==='granted'?'granted':p==='denied'?'denied':'default';callback?.(permission);return permission;}
    readonly title:string;
    onclick:((event:Event)=>void)|null=null;onclose:((event:Event)=>void)|null=null;onerror:((event:Event)=>void)|null=null;onshow:((event:Event)=>void)|null=null;
    constructor(title:string,options:NotificationOptions={}){super();this.title=title;if(permission==='granted')void invoke('notify',{title,body:options.body??''}).catch(()=>{});}
    close(){this.onclose?.(new Event('close'));}
  }
  Object.defineProperty(window,'Notification',{value:NativeNotification,writable:true,configurable:true});
}
