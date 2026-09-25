// IndexedDB persistence: session records (analysis) and audio blobs.

const DB_NAME = 'vocalassistant';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}

export const saveSession = (rec) => tx('sessions', 'readwrite', (s) => s.put(rec));
export const getSession = (id) => tx('sessions', 'readonly', (s) => s.get(id));
export const saveAudio = (id, blob) => tx('audio', 'readwrite', (s) => s.put(blob, id));
export const getAudio = (id) => tx('audio', 'readonly', (s) => s.get(id));

export async function listSessions() {
  const all = await tx('sessions', 'readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(id) {
  await tx('sessions', 'readwrite', (s) => s.delete(id));
  await tx('audio', 'readwrite', (s) => s.delete(id));
}

export async function clearAll() {
  await tx('sessions', 'readwrite', (s) => s.clear());
  await tx('audio', 'readwrite', (s) => s.clear());
}

