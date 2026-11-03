// 1つのモデルを動かす係（worker.js を包む）。ディスカッション（discussion.js）で、A と B のモデルを別々に動かすのに使う。
//
//   const r = new ModelRunner(modelId, { force, onStatus, onProgress, onLog });
//   await r.load();                                   // 実行環境を調べ、試す順番（models.js の planFor）で読み込む
//   const done = await r.generate(messages, params, maxContext, (text) => …);   // 返答を少しずつ受け取る
//   r.interrupt();                                    // 生成を止める（generate は、そこまでの結果で終わる）
//   r.dispose();                                      // worker を捨てる（モデルのメモリを手放す）
//
// 読み込みに失敗したら、worker を作り直して次の組み合わせで読み直す（ONNX Runtime は一度失敗した初期化を覚えているため）。

import { planFor, presetOf } from './models.js';

export class ModelRunner {
  /**
   * @param {string} modelId  Hugging Face のリポジトリ
   * @param {{ force?: {device?: string|null, dtype?: string|null}, onStatus?: Function, onProgress?: Function, onLog?: Function }} o
   */
  constructor(modelId, { force = {}, onStatus = () => {}, onProgress = () => {}, onLog = () => {} } = {}) {
    this.modelId = modelId;
    this.preset = presetOf(modelId);
    this.force = force;
    this.onStatus = onStatus;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.worker = null;
    this.plan = null;
    this.current = null; // { device, dtype }
    this.pending = null; // いま待っている応答 { resolve, reject, onToken }
  }

  get label() {
    return this.current ? `${this.current.device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}・${this.current.dtype}` : '';
  }

  startWorker() {
    this.worker?.terminate();
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.addEventListener('message', (e) => this.onMessage(e.data));
    w.addEventListener('error', (e) => this.fail(new Error('worker のエラー: ' + (e.message || 'ライブラリを読み込めない可能性があります'))));
    this.worker = w;
  }

  /** worker に頼んで、決まった種類の知らせが来るまで待つ */
  request(msg, until) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, until, onToken: msg.onToken };
      const { onToken, ...rest } = msg;
      this.worker.postMessage(rest);
    });
  }

  fail(err) {
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'progress': this.onProgress(msg); return;
      case 'status': this.onStatus(msg.text); return;
      case 'log': this.onLog(msg.text); return;
      case 'token': this.pending?.onToken?.(msg.text); return;
      case 'error': this.fail(Object.assign(new Error(msg.message), { during: msg.during })); return;
    }
    if (this.pending?.until === msg.type) {
      const p = this.pending;
      this.pending = null;
      p.resolve(msg);
    }
  }

  /** 読み込む。試す順番のすべてで失敗したら、最後のエラーで reject */
  async load() {
    this.startWorker();
    const probe = await this.request({ type: 'probe' }, 'probe');
    this.plan = planFor(probe, this.preset, this.force);
    this.onLog(`${this.modelId}: WebGPU ${probe.webgpu ? 'あり' : 'なし'}・試す順番 ${this.plan.map((x) => `${x.device}・${x.dtype}`).join(' → ')}`);
    if (this.preset?.webgpuOnly && this.plan[0].device !== 'webgpu') {
      throw new Error(`${this.preset.name} は WebGPU でしか動きません（このブラウザでは WebGPU が使えません）`);
    }
    let last = null;
    for (let i = 0; i < this.plan.length; i++) {
      const c = this.plan[i];
      if (i > 0) {
        this.onLog(`${this.modelId}: ${this.plan[i - 1].device}・${this.plan[i - 1].dtype} で読み込めなかったので、${c.device}・${c.dtype} で読み直す（${last?.message}）`);
        this.startWorker(); // 一度失敗した worker は使わない
      }
      try {
        const ready = await this.request({ type: 'load', model: this.modelId, ...c }, 'ready');
        this.current = { device: ready.device, dtype: ready.dtype };
        return { ...this.current, ms: ready.ms };
      } catch (e) {
        last = e;
      }
    }
    throw last ?? new Error('読み込めませんでした');
  }

  /** 返答を生成する。onToken に少しずつ文字を渡し、終わったら worker の done（トークン数・速さなど）で resolve */
  generate(messages, params, maxContext, onToken) {
    return this.request({ type: 'generate', messages, params, maxContext, onToken }, 'done');
  }

  interrupt() {
    this.worker?.postMessage({ type: 'interrupt' });
  }

  dispose() {
    this.fail(new Error('止めました'));
    this.worker?.terminate();
    this.worker = null;
  }
}
