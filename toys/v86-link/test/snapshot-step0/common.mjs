// スナップショットの調査（ステップ0）の共通部分: Node の v86 を VmNode と同じ形（on('frame') / injectFrame）で包む
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { V86 } = require('../../lib/v86/libv86.js');
export const LIB = new URL('../../lib/v86/', import.meta.url).pathname;
export const IMAGE = new URL('../../images/v86net-20261101-uclibc-gzip.bin', import.meta.url).pathname;
export const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
export const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

/**
 * opts: uart1 / initial_state（ArrayBuffer）/ noImage（bzimage・BIOS を渡さない）/ autostart
 */
export function vm(name, { uart1 = false, initial_state, noImage = false, autostart = true } = {}) {
  const cfg = { wasm_path: LIB + 'v86.wasm', memory_size: 64 << 20, net_device: { type: 'ne2k' },
    autostart, disable_speaker: true, disable_keyboard: true, disable_mouse: true, uart1 };
  if (!noImage) Object.assign(cfg, { bios: { url: LIB + 'bios/seabios.bin' }, vga_bios: { url: LIB + 'bios/vgabios.bin' }, bzimage: { url: IMAGE }, cmdline: CMDLINE });
  if (initial_state) cfg.initial_state = { buffer: initial_state };
  const e = new V86(cfg);
  const node = { name, e, out: ['', ''], listeners: new Set(), sent: [],
    on(t, fn) { if (t === 'frame') { node.listeners.add(fn); return () => node.listeners.delete(fn); } },
    injectFrame(f) { e.bus.send('net0-receive', f); } };
  e.add_listener('net0-send', (f) => { node.sent.push({ t: Date.now(), f: f.slice() }); node.listeners.forEach((fn) => fn(f)); });
  e.add_listener('serial0-output-byte', (b) => { node.out[0] += String.fromCharCode(b); });
  e.add_listener('serial1-output-byte', (b) => { node.out[1] += String.fromCharCode(b); });
  node.started = new Promise((r) => e.add_listener('emulator-started', r));
  node.send = (text, port = 0) => e.serial_send_bytes(port, new TextEncoder().encode(text));
  node.run = async (cmd, port = 0, ms = 30000) => {
    const mark = node.out[port].length; const tag = 'M' + Math.random().toString(36).slice(2, 8);
    node.send(`${cmd}; echo "${tag}""-END:$?"\n`, port);
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = new RegExp(`^${tag}-END:(\\d+)`, 'm').exec(node.out[port].slice(mark)); if (m) return { code: Number(m[1]), out: node.out[port].slice(mark).replace(/\r/g, '') }; await sleep(50); }
    return { code: -1, out: node.out[port].slice(mark).replace(/\r/g, '') };
  };
  return node;
}
export async function booted(n, ms = 120000) { const end = Date.now() + ms; while (!/% $/.test(n.out[0])) { if (Date.now() > end) throw new Error(n.name + ': prompt timeout'); await sleep(50); } }
export const macOfFrame = (f) => [...f.slice(6, 12)].map((x) => x.toString(16).padStart(2, '0')).join(':');
export async function gzipSize(buf) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter(); w.write(new Uint8Array(buf)); w.close();
  const t = Date.now(); const out = await new Response(cs.readable).arrayBuffer();
  return { bytes: out.byteLength, ms: Date.now() - t, out };
}
export async function gunzip(buf) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter(); w.write(new Uint8Array(buf)); w.close();
  return new Response(ds.readable).arrayBuffer();
}
export const mem = () => { const m = process.memoryUsage(); return { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), extMB: Math.round((m.external + m.arrayBuffers) / 1048576) }; };
