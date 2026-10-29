// VM の抽象化。UI と仮想スイッチは VmNode のインターフェースだけを使い、エンジン（v86 など）には依存しない。
//
//   VmNode（エンジンに依存しない）
//     start()            起動する（ダウンロード → ブート）。終わると "state" イベントで "running"
//     stop()             止める
//     writeSerial(text)  シリアルコンソールへの入力
//     injectFrame(bytes) 仮想スイッチから届いた Ethernet フレームを NIC に渡す
//     on(type, fn)       "serial"（Uint8Array: シリアル出力）・"frame"（Uint8Array: NIC が送ったフレーム）
//                        "progress"（{phase, loaded, total}）・"state"（"starting" / "running" / "stopped" / "error"）
//
//   V86Node（v86 での実装。v86 固有の処理はこのクラスの中だけにある）
//
// 別のエンジン（container2wasm など）に差し替えるときは、VmNode を継承したクラスを作り、
// シリアルの入出力とフレームの送受信を同じイベント・メソッドに結び付ければよい。

export class VmNode {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, value) {
    for (const fn of this.listeners.get(type) ?? []) fn(value);
  }

  async start() { throw new Error('not implemented'); }
  async stop() { throw new Error('not implemented'); }
  writeSerial() { throw new Error('not implemented'); }
  injectFrame() { throw new Error('not implemented'); }
}

/**
 * ファイルを1回だけダウンロードする（同じイメージを2台で共有する）。進み具合は onProgress(loaded, total) で知らせる
 */
export async function download(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

/**
 * v86 で動く VM。libv86.js（グローバルの V86）が読み込まれている前提。
 * オプション名は v86 0.5.472 の v86.d.ts と examples/two_instances.html に合わせている
 */
export class V86Node extends VmNode {
  /**
   * @param {string} name
   * @param {object} config
   *   libPath:   libv86.js・v86.wasm・bios/ のあるフォルダ
   *   bzimage:   Linux カーネル（initramfs 入り）の ArrayBuffer
   *   cmdline:   カーネルのコマンドライン
   *   memoryMB:  ゲストのメモリ
   */
  constructor(name, config) {
    super(name);
    this.config = config;
    this.emulator = null;
    this.pending = [];        // まとめて送るシリアル出力
    this.flushTimer = 0;
  }

  async start() {
    const { libPath, bzimage, cmdline, memoryMB } = this.config;
    this.emit('state', 'starting');
    const emulator = new V86({
      wasm_path: libPath + 'v86.wasm',
      bios: { url: libPath + 'bios/seabios.bin' },
      vga_bios: { url: libPath + 'bios/vgabios.bin' },
      bzimage: { buffer: bzimage },
      cmdline,
      memory_size: memoryMB * 1024 * 1024,
      // NIC は ne2k（v86 の既定）。relay_url を指定しないので、外にはつながらず
      // net0-send / net0-receive でフレームをやりとりするだけになる
      net_device: { type: 'ne2k' },
      // 画面は使わない（シリアルコンソールで操作する）。キーボード・マウスも取らない
      disable_keyboard: true,
      disable_mouse: true,
      autostart: true,
    });
    this.emulator = emulator;

    emulator.add_listener('download-progress', (e) => {
      this.emit('progress', { phase: 'download', loaded: e.loaded, total: e.total, file: e.file_name });
    });
    emulator.add_listener('emulator-ready', () => this.emit('progress', { phase: 'boot' }));
    // シリアル出力は1バイトずつ来るので、少しためてから流す（端末の描画を減らす）
    emulator.add_listener('serial0-output-byte', (byte) => {
      this.pending.push(byte);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 8);
    });
    // NIC が送ったフレーム（Uint8Array）。そのまま仮想スイッチへ
    emulator.add_listener('net0-send', (frame) => this.emit('frame', frame));

    await new Promise((resolve, reject) => {
      emulator.add_listener('emulator-started', resolve);
      emulator.add_listener('download-error', (e) => reject(new Error('download failed: ' + e.file_name)));
    });
  }

  flush() {
    this.flushTimer = 0;
    const bytes = Uint8Array.from(this.pending);
    this.pending = [];
    this.emit('serial', bytes);
  }

  async stop() {
    if (!this.emulator) return;
    await this.emulator.destroy();
    this.emulator = null;
    this.emit('state', 'stopped');
  }

  writeSerial(text) {
    // serial0_send は文字コードの下位8ビットしか送らない（日本語が化ける）ので、UTF-8 のバイト列で送る
    this.emulator?.serial_send_bytes(0, new TextEncoder().encode(text));
  }

  injectFrame(frame) {
    this.emulator?.bus.send('net0-receive', frame);
  }
}
