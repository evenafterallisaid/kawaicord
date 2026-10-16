import type { Invoke } from './discord-settings';
const hosts = new Set(['cloud.equicord.org', 'api.vencord.dev']);
export function installCloudBridge(invoke: Invoke) {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    let url: URL;
    try { url = new URL(address, location.href); } catch { return original(input, init); }
    if (url.protocol !== 'https:' || !hosts.has(url.hostname)) return original(input, init);
    const request = new Request(input, init);
    const payload = { url: request.url, method: request.method, headers: Array.from(request.headers.entries()), body: Array.from(new Uint8Array(await request.arrayBuffer())) };
    const response = await invoke<{ status: number; headers: Array<[string, string]>; body: number[] }>('cloud_request', { request: payload });
    return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
  };
}
