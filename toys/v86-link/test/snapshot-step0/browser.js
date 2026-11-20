// スナップショットの調査（ステップ0）のブラウザ側。browser.cjs（Playwright）から window.snap.* を呼ぶ
const LIB = '../../lib/v86/';
const IMAGE = '../../images/v86net-20261101-uclibc-gzip.bin';
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vms = new Map();
let tpl = null;

function make(name, { state = null } = {}) {
  const cfg = { wasm_path: LIB + 'v86.wasm', memory_size: 64 << 20, net_device: { type: 'ne2k' }, autostart: true,
    disable_speaker: true, disable_keyboard: true, disable_mouse: true, uart1: true };
  if (state) cfg.initial_state = { buffer: state };
  else Object.assign(cfg, { bios: { url: LIB + 'bios/seabios.bin' }, vga_bios: { url: LIB + 'bios/vgabios.bin' }, bzimage: { url: IMAGE }, cmdline: CMDLINE });
  const e = new V86(cfg);
  const n = { e, out: '' };
  e.add_listener('serial0-output-byte', (b) => { n.out += String.fromCharCode(b); });
  vms.set(name, n);
  return n;
}
async function prompt(n, ms = 120000) {
  const end = performance.now() + ms;
  while (!/% $/.test(n.out)) { if (performance.now() > end) throw new Error('prompt timeout'); await sleep(20); }
}
async function pipe(buf, stream) {
  return new Response(new Blob([buf]).stream().pipeThrough(stream)).arrayBuffer();
}

window.snap = {
  async template() {
    let t = performance.now();
    const n = make('T');
    await prompt(n);
    const bootMs = performance.now() - t;
    t = performance.now();
    tpl = await n.e.save_state();
    const saveMs = performance.now() - t;
    t = performance.now();
    const gz = await pipe(tpl, new CompressionStream('gzip'));
    const gzipMs = performance.now() - t;
    t = performance.now();
    const back = await pipe(gz, new DecompressionStream('gzip'));
    const gunzipMs = performance.now() - t;
    return { bootMs: Math.round(bootMs), saveMs: Math.round(saveMs), raw: tpl.byteLength, gzip: gz.byteLength, gzipMs: Math.round(gzipMs), gunzipMs: Math.round(gunzipMs), roundTripSame: back.byteLength === tpl.byteLength };
  },
  /** count 台を同時に復元し、全台のプロンプトまでの時間 */
  async restore(count, prefix) {
    const t = performance.now();
    const ns = Array.from({ length: count }, (_, i) => make(prefix + i, { state: tpl.slice(0) }));
    const each = await Promise.all(ns.map(async (n) => {
      await new Promise((r) => n.e.add_listener('emulator-started', r));
      n.e.serial_send_bytes(0, new TextEncoder().encode('\n'));
      await prompt(n, 30000);
      return Math.round(performance.now() - t);
    }));
    return { allMs: Math.round(performance.now() - t), each };
  },
  /** count 台を普通に（BIOS から）同時に起動し、全台のプロンプトまでの時間（比べるため） */
  async bootNormal(count, prefix) {
    const t = performance.now();
    const ns = Array.from({ length: count }, (_, i) => make(prefix + i));
    await Promise.all(ns.map((n) => prompt(n)));
    return { allMs: Math.round(performance.now() - t) };
  },
  async destroy(prefix) {
    for (const [k, n] of [...vms]) if (k.startsWith(prefix)) { await n.e.destroy(); vms.delete(k); }
    return vms.size;
  },
  /** 1 台を動かしたまま restore_state を times 回 */
  async restoreInPlace(times) {
    const n = make('IP', { state: tpl.slice(0) });
    await new Promise((r) => n.e.add_listener('emulator-started', r));
    for (let i = 0; i < times; i++) {
      await n.e.restore_state(tpl.slice(0));
      n.out = '';
      n.e.serial_send_bytes(0, new TextEncoder().encode('\n'));
      await prompt(n, 30000);
    }
    await n.e.destroy();
    vms.delete('IP');
  },
};
document.getElementById('s').textContent = 'ready';
