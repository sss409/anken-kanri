// IndexedDB に保存する
// projects: 案件 1 件 1 レコード
// invoices: 請求月 × クライアント ごとの請求書発行・振込の状態
const DB_NAME = 'anken-kanri';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('invoices')) db.createObjectStore('invoices', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const loadAll = () => run('projects', 'readonly', (tx) => tx.objectStore('projects').getAll());
export const saveProject = (p) => run('projects', 'readwrite', (tx) => tx.objectStore('projects').put(p));
export const deleteProject = (id) => run('projects', 'readwrite', (tx) => tx.objectStore('projects').delete(id));

export const loadInvoices = () => run('invoices', 'readonly', (tx) => tx.objectStore('invoices').getAll());
export const saveInvoice = (r) => run('invoices', 'readwrite', (tx) => tx.objectStore('invoices').put(r));

export function replaceAll(projects, invoices) {
  return run(['projects', 'invoices'], 'readwrite', (tx) => {
    const ps = tx.objectStore('projects');
    const is = tx.objectStore('invoices');
    ps.clear();
    is.clear();
    for (const p of projects) ps.put(p);
    for (const r of invoices) is.put(r);
  });
}
