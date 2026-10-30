import type { Invoke } from './discord-settings';

export function installNotifications(invoke: Invoke, enabled: () => boolean) {
  let permission: NotificationPermission = 'default';
  let refreshing: Promise<NotificationPermission> | undefined;
  let nextId = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000;
  const active = new Map<number, NativeNotification>();
  const normalize = (value: string): NotificationPermission => value === 'granted' ? 'granted' : value === 'denied' ? 'denied' : 'default';
  const refresh = () => {
    if (!enabled()) return Promise.resolve('denied' as const);
    return refreshing ??= invoke<string>('notification_permission', { request: false })
      .then(value => permission = normalize(value)).catch(() => permission).finally(() => { refreshing = undefined; });
  };
  class NativeNotification extends EventTarget {
    static get permission() { return enabled() ? permission : 'denied'; }
    static async requestPermission(callback?: (permission: NotificationPermission) => void) {
      const value = enabled() ? normalize(await invoke<string>('notification_permission', { request: true })) : 'denied';
      permission = value; callback?.(value); return value;
    }
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly id: number;
    private closed = false;
    onclick: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onshow: ((event: Event) => void) | null = null;
    constructor(title: string, options: NotificationOptions = {}) {
      super(); this.title = title; this.body = options.body ?? ''; this.tag = options.tag ?? ''; this.id = ++nextId % 2_000_000_000;
      if (this.tag) for (const previous of active.values()) if (previous.tag === this.tag) previous.close();
      active.set(this.id, this);
      while (active.size > 64) active.delete(active.keys().next().value!);
      void refresh().then(async value => {
        if (this.closed) return;
        if (!enabled() || value !== 'granted') throw new Error('Notifications are disabled');
        await invoke('notify', { id: this.id, title: this.title, body: this.body });
        if (!this.closed) this.emit('show');
      }).catch(() => { active.delete(this.id); if (!this.closed) this.emit('error'); });
    }
    emit(type: 'click' | 'close' | 'error' | 'show') {
      const event = new Event(type); this.dispatchEvent(event); this[`on${type}`]?.(event);
    }
    close() {
      if (this.closed) return;
      this.closed = true; active.delete(this.id);
      void invoke('close_notification', { id: this.id }).catch(() => {});
      this.emit('close');
    }
  }
  (window as any).__kawaicordNotificationClick = (id: number) => {
    const notification = active.get(id); if (notification) { active.delete(id); notification.emit('click'); }
  };
  Object.defineProperty(window, 'Notification', { value: NativeNotification, writable: true, configurable: true });
  window.addEventListener('focus', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh();
  return refresh;
}
