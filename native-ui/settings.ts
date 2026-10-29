import { invoke } from '@tauri-apps/api/core';
import type { Config,RuntimeStatus } from './types';
const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const notice=get('notice');
function error(value:unknown){notice.textContent=String(value);}
async function action(button:HTMLButtonElement,fn:()=>Promise<unknown>){button.disabled=true;notice.textContent='';try{await fn();}catch(e){error(e);}finally{button.disabled=false;}}
let config:Config;
const flags:Array<[keyof Config,string,string]>=[
  ['performanceMode','Background performance mode','Pause decorative animation and avatar painting while hidden.'],
  ['staticNameplates','Use static nameplates','Preserve colors and transparency when the webview cannot render transparent nameplate videos.'],
  ['richPresence','Local Rich Presence','Accept activity from games and applications through native Discord RPC.'],
  ['detectGames','Detect running games','Optional native process check every 30 seconds. Off by default to reduce background work.'],
  ['notifications','Desktop notifications','Allow Discord notifications through the native notification service.'],
  ['trayEnabled','Show tray icon','Keep Discord accessible from the system tray or macOS menu bar.'],
  ['minimizeToTray','Keep running when closed','Closing the window hides it. Use Quit to exit Kawaicord.'],
  ['startAtLogin','Start at login','Launch Kawaicord when you sign in.'],
  ['autoUpdateMods','Refresh client mods automatically','Download official browser builds for the next restart.'],
  ['previewUpdates','Receive preview updates','Include experimental releases when checking for updates. Off by default.'],
  ['autoUpdateApp','Check for app updates','Check for signed native releases without interrupting calls.']
];
async function load(){
  const data=await invoke<{config:Config;runtime:RuntimeStatus;updater:{available:boolean;message:string}}>('get_settings');config=data.config;
  get('version').textContent=`Version ${data.runtime.version}`;
  get('runtime').textContent=data.runtime.safeMode?'Recovery mode':data.runtime.ready?'Connected':'Starting Discord';
  get('mod-status').textContent=data.runtime.error??`${data.runtime.modules} Discord modules initialized`;
  get<HTMLSelectElement>('mod').value=config.activeMod;
  get('update-status').textContent=data.updater.message;
  get('apply-update').hidden=!data.updater.available;
  const options=get('options');options.replaceChildren();
  for(const [key,title,description] of flags){
    const label=document.createElement('label');label.className='option';const text=document.createElement('div');
    const heading=document.createElement('span');heading.textContent=title;const detail=document.createElement('small');detail.textContent=description;text.append(heading,detail);
    const input=document.createElement('input');input.type='checkbox';input.setAttribute('role','switch');input.checked=config[key]===true;
    input.onchange=()=>void action(input as unknown as HTMLButtonElement,async()=>{try{config=await invoke<Config>('save_config',{config:{...config,[key]:input.checked}});}catch(e){input.checked=!input.checked;throw e;}});
    label.append(text,input);options.append(label);
  }
}
function bind(id:string,fn:()=>Promise<unknown>){const button=get<HTMLButtonElement>(id);button.onclick=()=>void action(button,fn);}
bind('restart',async()=>{const activeMod=get<HTMLSelectElement>('mod').value;await invoke('save_config',{config:{...config,activeMod}});await invoke('restart_app');});
bind('recovery',()=>invoke('restart_recovery'));bind('normal',()=>invoke('restart_app'));
bind('open-discord',()=>invoke('show_discord'));
bind('refresh-mods',async()=>{await invoke('refresh_mods');notice.textContent='Mod bundles refreshed. Restart Kawaicord to apply them.';});
bind('check-update',async()=>{get('apply-update').hidden=true;get('update-status').textContent='Checking for updates…';try{const result=await invoke<{available:boolean;message:string}>('check_update');get('update-status').textContent=result.message;get('apply-update').hidden=!result.available;}catch(error){get('update-status').textContent=String(error);throw error;}});
bind('apply-update',async()=>{get('update-status').textContent='Downloading and verifying the update…';try{await invoke('install_update');}catch(error){get('update-status').textContent=String(error);throw error;}});
get('project').onclick=event=>{event.preventDefault();void invoke('open_releases').catch(error);};
void load().catch(error);
