import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { commands, trusted } from './policy';
if (process.isMainFrame && (trusted(location.href) || location.protocol === 'file:')) {
  contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', { invoke: (command: string, args: Record<string, unknown> = {}) => {
    if (!commands.has(command)) return Promise.reject(new Error('Unsupported client action'));
    return ipcRenderer.invoke('kawaicord:invoke', command, args);
  } });
  if (trusted(location.href)) {
    const source = ipcRenderer.sendSync('kawaicord:initialization');
    if (typeof source === 'string') void webFrame.executeJavaScript(source).catch(() => ipcRenderer.send('kawaicord:initialization-failed'));
  }
}
