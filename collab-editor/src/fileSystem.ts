// ── File System Access API type declarations ─────────────────────────────────
// These are in TypeScript's DOM lib since TS 5.4, declared here for safety.

interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void>;
}

export interface FSFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
  queryPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

declare global {
  interface Window {
    showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FSFileHandle[]>;
    showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FSFileHandle>;
  }
}

// ── Feature detection ─────────────────────────────────────────────────────────

export const supportsFileSystemAccess =
  typeof window !== "undefined" && "showOpenFilePicker" in window;

// ── IndexedDB persistence for FileSystemFileHandle ────────────────────────────
// FileSystemFileHandle is structured-cloneable and can live in IDB across
// page reloads. The browser will re-prompt for permission on the next visit.

const DB_NAME = "collab-editor-fs";
const STORE = "handles";
const KEY = "lastFile";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandleToIDB(handle: FSFileHandle): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getHandleFromIDB(): Promise<FSFileHandle | null> {
  const db = await openDB();
  const result = await new Promise<FSFileHandle | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as FSFileHandle | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result ?? null;
}

export async function clearHandleFromIDB(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ── Permission helpers ────────────────────────────────────────────────────────

export async function requestReadWritePermission(handle: FSFileHandle): Promise<boolean> {
  try {
    const current = await handle.queryPermission({ mode: "readwrite" });
    if (current === "granted") return true;
    const requested = await handle.requestPermission({ mode: "readwrite" });
    return requested === "granted";
  } catch {
    return false;
  }
}

// ── File operations ───────────────────────────────────────────────────────────

export async function writeToHandle(handle: FSFileHandle, content: string): Promise<void> {
  // createWritable() with no options truncates to 0 before writing, so the
  // file always ends up exactly the size of `content` (no stale trailing bytes).
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** Show the OS open-file picker; returns null if the user cancels. */
export async function openFilePicker(): Promise<{ handle: FSFileHandle; content: string } | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      excludeAcceptAllOption: false,
      types: [{ description: "Text files", accept: { "text/plain": [".txt"] } }],
    });
    const file = await handle.getFile();
    const content = await file.text();
    return { handle, content };
  } catch {
    return null; // user cancelled (AbortError)
  }
}

/** Show the OS save-file picker; returns null if the user cancels. */
export async function saveFilePicker(suggestedName = "document"): Promise<FSFileHandle | null> {
  try {
    return await window.showSaveFilePicker({
      suggestedName: suggestedName.endsWith(".txt") ? suggestedName : `${suggestedName}.txt`,
      types: [{ description: "Text files", accept: { "text/plain": [".txt"] } }],
    });
  } catch {
    return null;
  }
}
