// IndexedDB を Promise で使うための薄いラッパー。
// 同じサイトの他のおもちゃと混ざらないよう、データベース名におもちゃの名前を付ける。
//
// ストア:
//   state  … ゲームの状態（キー "current" の1件だけ）
//   events … 日誌（time の索引で新しい順に読む）
//   works  … 作品（盆栽の写真を Blob で持つ。time の索引つき）

const DB_NAME = "toys-bonsai";
const VERSION = 1;

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function openDB() {
  const req = indexedDB.open(DB_NAME, VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("state");
    db.createObjectStore("events", { keyPath: "id", autoIncrement: true }).createIndex("time", "time");
    db.createObjectStore("works", { keyPath: "id", autoIncrement: true }).createIndex("time", "time");
  };
  const db = await done(req);
  const store = (name, mode = "readonly") => db.transaction(name, mode).objectStore(name);

  return {
    get: (name, key) => done(store(name).get(key)),
    put: (name, value, key) => done(store(name, "readwrite").put(value, key)),
    add: (name, value) => done(store(name, "readwrite").add(value)),
    count: name => done(store(name).count()),

    // 新しい順に最大 limit 件
    latest(name, limit) {
      return new Promise((resolve, reject) => {
        const out = [];
        const req = store(name).index("time").openCursor(null, "prev");
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor && out.length < limit) {
            out.push(cursor.value);
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        req.onerror = () => reject(req.error);
      });
    },

    clearAll() {
      const tx = db.transaction(["state", "events", "works"], "readwrite");
      for (const name of ["state", "events", "works"]) tx.objectStore(name).clear();
      return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
