import type { Invoke } from './discord-settings';
export function instanceHelpers(invoke: Invoke) {
  const result = async (command: string, args?: Record<string, unknown>) => {
    try { await invoke(command, args); return { ok: true }; }
    catch (error) { return { ok: false, error: String(error) }; }
  };
  return { MultiInstance: {
    getOpenInstances: () => invoke('list_instances'),
    openInstance: (id: string, name: string, saveSession: boolean, domain: string, blockExternalTokenAccess: boolean, performanceMode: boolean, mode: string) => result('open_instance', { id, name, saveSession, domain, blockExternalTokenAccess, performanceMode, mode }),
    closeInstance: (id: string) => result('close_instance', { id }),
    closeAllInstances: () => result('close_all_instances'),
    clearSavedSession: (id: string) => result('clear_instance_session', { id }),
    reportInstanceUser: (user: unknown) => invoke('report_instance_user', { user })
  } };
}
