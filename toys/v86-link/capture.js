// キャプチャの記録（DOM にも v86 にも依存しない。Node でテストできる）。
//
// 仮想スイッチが処理したフレームを1件ずつ、リングバッファに記録する。
//   { no, ts, frame, inPort, outPorts, dropped, reason }
//     no:       通し番号（1 から。古いものを捨てても番号は詰めない）
//     ts:       UNIX 時刻のミリ秒（performance.timeOrigin + performance.now()。小数で µs 程度まで）
//     frame:    フレームの複製（Uint8Array）
//     inPort:   入ってきたポートの番号
//     outPorts: 届けたポートの番号の配列（捨てたときは空）
//     dropped:  捨てたか（届け先が1つも無い）
//     reason:   捨てた理由（"cable" = ケーブルが抜けている / "loss" = 損失の設定 / "no-port" / "runt"。switch.js）。
//               一部の届け先だけ捨てたときも入る
//
// 件数とバイト数の上限を超えたら、古いものから捨てる（捨てた件数は evicted で分かる）。
//
// TrafficStats は、パケットモニタの集計（フレーム数・バイト数・捨てた数・種類）。
// キャプチャと同じ仮想スイッチの知らせ（onFrame）から数える。キャプチャの停止・クリア・上限には左右されない。

import { classify } from './switch.js';

export const DEFAULT_LIMITS = { maxRecords: 20000, maxBytes: 16 * 1024 * 1024 };

export class Capture {
  constructor(limits = DEFAULT_LIMITS, clock = () => performance.timeOrigin + performance.now()) {
    this.maxRecords = limits.maxRecords;
    this.maxBytes = limits.maxBytes;
    this.clock = clock;
    this.listeners = new Set();
    this.running = true;   // ページを開いたときから記録する
    this.clear();
  }

  /** 中身を空にする（キャプチャの開始時刻もここからにする） */
  clear() {
    this.records = [];
    this.head = 0;          // records のうち、まだ捨てていない先頭（配列を毎回詰めないため）
    this.bytes = 0;
    this.nextNo = 1;
    this.evicted = 0;
    this.startedAt = this.clock();
    this.changed();
  }

  start() {
    if (!this.running) {
      this.running = true;
      this.changed();
    }
  }

  stop() {
    if (this.running) {
      this.running = false;
      this.changed();
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn(this);
  }

  /** 仮想スイッチの "frame" の知らせを記録する */
  add({ frame, inPort, outPorts = [], reason = null, ts = this.clock() }) {
    if (!this.running) return null;
    const copy = Uint8Array.from(frame ?? []);
    const record = {
      no: this.nextNo++, ts, frame: copy, inPort, outPorts: [...outPorts],
      dropped: outPorts.length === 0, reason,
    };
    this.records.push(record);
    this.bytes += copy.length;
    this.evict();
    this.changed();
    return record;
  }

  evict() {
    while (this.size > 0 && (this.size > this.maxRecords || this.bytes > this.maxBytes)) {
      this.bytes -= this.records[this.head].frame.length;
      this.records[this.head] = undefined;
      this.head++;
      this.evicted++;
    }
    // 捨てた分がたまったら、配列を詰める
    if (this.head > 4096 && this.head > this.records.length / 2) {
      this.records = this.records.slice(this.head);
      this.head = 0;
    }
  }

  get size() {
    return this.records.length - this.head;
  }

  /** i 番目（0 = いちばん古い） */
  at(i) {
    return this.records[this.head + i];
  }

  /** 残っている記録（古い順）。includeDropped が false なら、転送したものだけ */
  list({ includeDropped = true } = {}) {
    const out = [];
    for (let i = this.head; i < this.records.length; i++) {
      const r = this.records[i];
      if (includeDropped || !r.dropped) out.push(r);
    }
    return out;
  }
}

/** パケットモニタの集計（仮想スイッチの onFrame から1フレームずつ数える） */
export class TrafficStats {
  constructor() {
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.frames = 0;      // 届けたフレーム（届け先が1つ以上）
    this.bytes = 0;
    this.dropped = 0;     // 届け先が1つも無く、捨てたフレーム
    this.types = {};
    this.changed();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  changed() {
    for (const fn of this.listeners) fn(this);
  }

  add({ frame, outPorts }) {
    if (outPorts.length === 0) {
      this.dropped++;
    } else {
      const type = classify(frame);
      this.frames++;
      this.bytes += frame.length;
      this.types[type] = (this.types[type] ?? 0) + 1;
    }
    this.changed();
  }
}
