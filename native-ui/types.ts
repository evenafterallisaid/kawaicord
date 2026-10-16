export type ClientMod = 'vencord' | 'equicord' | 'illegalcord';
export interface Config {
  activeMod: ClientMod; performanceMode: boolean; staticNameplates: boolean; richPresence: boolean; detectGames:boolean; trayEnabled: boolean;
  minimizeToTray: boolean; startAtLogin: boolean; autoUpdateMods: boolean; autoUpdateApp: boolean; notifications: boolean;
}
export interface RuntimeStatus {
  activeMod: ClientMod; safeMode: boolean; shelter: boolean; modules: number; ready: boolean;
  media: boolean; screenSharing: boolean; error: string | null; version: string; platform: string;
}
