const origins = new Set(['https://discord.com', 'https://ptb.discord.com', 'https://canary.discord.com']);
export function trusted(address: string) {
  try { const url = new URL(address); return origins.has(url.origin) && !url.username && !url.password; } catch { return false; }
}
export function embedded(address: string) {
  if (address === 'about:blank' || address === 'about:srcdoc') return true;
  try { const url = new URL(address); return url.protocol === 'https:' && !url.port && !url.username && !url.password && (origins.has(url.origin) || url.hostname === 'hcaptcha.com' || url.hostname.endsWith('.hcaptcha.com') || url.hostname === 'open.spotify.com' && (url.pathname === '/embed' || url.pathname.startsWith('/embed/'))); } catch { return false; }
}
export function external(address: string) {
  try {
    const url = new URL(address);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return true;
    const tracking = [...url.searchParams].every(([key, value]) => key === 'utm_source' && value === 'discord' || key === 'utm_medium' && ['desktop', 'user_activity_play', 'user_activity_sync', 'embed_sync'].includes(value));
    return url.protocol === 'spotify:' && !url.host && tracking && !url.hash && (url.pathname === '' || /^(track|album|artist|playlist|episode|show):[a-zA-Z0-9]{22}$/.test(url.pathname));
  } catch { return false; }
}
export function instanceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(value)) throw new Error('Invalid instance identifier');
  return value;
}
export const commands = new Set(['window_action', 'open_link', 'get_settings', 'save_config', 'cloud_request', 'report_runtime', 'refresh_mods', 'check_update', 'install_update', 'notification_permission', 'notify', 'close_notification', 'set_unread', 'restart_app', 'restart_recovery', 'reload_discord', 'open_settings', 'show_discord', 'open_releases', 'list_instances', 'open_instance', 'close_instance', 'close_all_instances', 'clear_instance_session', 'report_instance_user']);
