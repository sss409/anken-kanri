// IndexedDB に保存する
// projects: 案件 1 件 1 レコード
// invoices: 請求月 × クライアント ごとの請求書発行・振込の状態
// deleted : 削除した案件の id と日時（同期先で消し戻されないように残す）
const DB_NAME = 'anken-kanri';
const STORES = ['projects', 'invoices', 'deleted'];

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('invoices')) db.createObjectStore('invoices', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('deleted')) db.createObjectStore('deleted', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // 別のタブで新しい版が開かれたら、更新を止めないようにこちらは閉じて読み直す
        db.onversionchange = () => { db.close(); location.reload(); };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => alert('別のタブで「案件管理」が開いたままです。ほかのタブを閉じると続きが表示されます。');
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

const loadAll = () => run('projects', 'readonly', (tx) => tx.objectStore('projects').getAll());
const saveProject = (p) => run('projects', 'readwrite', (tx) => tx.objectStore('projects').put(p));

const loadInvoices = () => run('invoices', 'readonly', (tx) => tx.objectStore('invoices').getAll());
const saveInvoice = (r) => run('invoices', 'readwrite', (tx) => tx.objectStore('invoices').put(r));

const loadDeleted = () => run('deleted', 'readonly', (tx) => tx.objectStore('deleted').getAll());

// 案件を消し、消したことを記録する
function deleteProject(id, deletedAt) {
  return run(['projects', 'deleted'], 'readwrite', (tx) => {
    tx.objectStore('projects').delete(id);
    tx.objectStore('deleted').put({ id, deletedAt });
  });
}

function replaceAll({ projects, invoices, deleted }) {
  return run(STORES, 'readwrite', (tx) => {
    const put = (name, list) => {
      const s = tx.objectStore(name);
      s.clear();
      for (const r of list) s.put(r);
    };
    put('projects', projects);
    put('invoices', invoices);
    put('deleted', deleted);
  });
}
