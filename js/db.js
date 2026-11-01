// IndexedDB に案件を 1 件 1 レコードで保存する
const DB_NAME = 'anken-kanri';
const STORE = 'projects';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const loadAll = () => run('readonly', (s) => s.getAll());
export const saveProject = (p) => run('readwrite', (s) => s.put(p));
export const deleteProject = (id) => run('readwrite', (s) => s.delete(id));

export function replaceAll(list) {
  return run('readwrite', (s) => {
    s.clear();
    for (const p of list) s.put(p);
  });
}
