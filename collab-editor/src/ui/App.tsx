import React, { useState, useEffect, useRef } from "react";
import { useCollabClient } from "../hooks/useCollabClient";
import { useOfflineQueue } from "../hooks/useOfflineQueue";
import { EditorView, type EditorViewHandle } from "../editor/EditorView";
import { usePresence } from "../hooks/usePresence";
import { ConnectionStatus } from "./ConnectionStatus";
import { DocumentTitle } from "./DocumentTitle";
import { PresenceBar } from "./PresenceBar";
import { RoleManager } from "./RoleManager";
import {
  type FSFileHandle,
  supportsFileSystemAccess,
  openFilePicker,
  saveFilePicker,
  writeToHandle,
  saveHandleToIDB,
  getHandleFromIDB,
  requestReadWritePermission,
} from "../fileSystem";

const LS_SITE_ID = "collab-siteId";
const LS_TOKEN = "collab-token";
const HB_INTERVAL_MS = 5_000;

// Fallback: download a blob when File System Access API is unavailable.
function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export const App: React.FC = () => {
  const [siteId, setSiteId] = useState(
    () => localStorage.getItem(LS_SITE_ID) ?? `site_${Math.floor(Math.random() * 1000)}`
  );
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN) ?? "");
  const [connected, setConnected] = useState(false);
  const [manuallyOffline, setManuallyOffline] = useState(false);

  // File management
  const [fileHandle, setFileHandle] = useState<FSFileHandle | null>(null);
  const [openedFileName, setOpenedFileName] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  // useCollabClient owns the ClientSync lifetime — ConnectionManager handles
  // exponential-backoff reconnects; on reconnect flushQueue() drains OfflineQueue.
  const { client, connectionState, peers, metaVersion } = useCollabClient(
    siteId,
    `ws://${window.location.hostname}:8787`,
    token,
    connected,
  );

  // Poll the engine's IndexedDB queue size so the UI can show pending op count.
  const queuedOps = useOfflineQueue(client, connectionState);

  const presences = usePresence(client, metaVersion);
  const editorRef = useRef<EditorViewHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasAutoLoaded = useRef(false);

  // ── Auto-load last opened file once connected ──────────────────────────────
  useEffect(() => {
    if (!client || connectionState !== "connected" || hasAutoLoaded.current) return;
    if (!supportsFileSystemAccess) return;
    hasAutoLoaded.current = true;

    void (async () => {
      const handle = await getHandleFromIDB();
      if (!handle) return;
      const granted = await requestReadWritePermission(handle);
      if (!granted) return;
      const file = await handle.getFile();
      const content = await file.text();
      setFileHandle(handle);
      setOpenedFileName(handle.name);
      editorRef.current?.setContent(content);
    })();
  }, [client, connectionState]);

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!client || connectionState !== "connected") return;
    const fire = () => client.setMeta(`hb:${siteId}`, Date.now());
    fire();
    heartbeatRef.current = setInterval(fire, HB_INTERVAL_MS);
    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current); };
  }, [client, connectionState, siteId]);

  // ── Save helpers ──────────────────────────────────────────────────────────
  const flashSaved = (status: SaveStatus) => {
    setSaveStatus(status);
    setTimeout(() => setSaveStatus("idle"), 1500);
  };

  const doSave = async () => {
    if (!client) return;
    const content = client.getText();
    const suggestedName =
      (client.replica.lww.get("title") as string | undefined) ??
      openedFileName ??
      "document";

    if (supportsFileSystemAccess) {
      let handle = fileHandle;
      if (!handle) {
        handle = await saveFilePicker(suggestedName);
        if (!handle) return; // user cancelled
        setFileHandle(handle);
        setOpenedFileName(handle.name);
        await saveHandleToIDB(handle);
      }
      setSaveStatus("saving");
      try {
        await writeToHandle(handle, content);
        flashSaved("saved");
      } catch {
        flashSaved("error");
      }
    } else {
      downloadFile(content, suggestedName.endsWith(".txt") ? suggestedName : `${suggestedName}.txt`);
      flashSaved("saved");
    }
  };

  // ── Ctrl+S ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, fileHandle, openedFileName]);

  // ── Manual offline toggle (for demo / testing) ───────────────────────────
  const handleGoOffline = () => {
    if (!client) return;
    client.disconnect();
    setManuallyOffline(true);
  };

  const handleReconnect = async () => {
    if (!client) return;
    setManuallyOffline(false);
    try {
      await client.connect();
    } catch {
      setManuallyOffline(true);
    }
  };

  // ── Open file ─────────────────────────────────────────────────────────────
  const handleOpenClick = async () => {
    if (supportsFileSystemAccess) {
      const result = await openFilePicker();
      if (!result) return;
      const { handle, content } = result;
      setFileHandle(handle);
      setOpenedFileName(handle.name);
      await saveHandleToIDB(handle);
      editorRef.current?.setContent(content);
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFallbackFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    editorRef.current?.setContent(text);
    setOpenedFileName(file.name);
    e.target.value = "";
  };

  // ── 1. Login screen ───────────────────────────────────────────────────────
  if (!connected) {
    return (
      <div style={{ padding: "2rem", maxWidth: "400px", margin: "0 auto", fontFamily: "sans-serif" }}>
        <h1>collab-editor-v1</h1>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <label>
            Site ID:
            <input style={{ width: "100%", marginTop: "4px" }} value={siteId} onChange={(e) => setSiteId(e.target.value)} />
          </label>
          <label>
            Token:
            <input style={{ width: "100%", marginTop: "4px" }} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste token here..." />
          </label>
          <button
            style={{ padding: "10px", marginTop: "10px", cursor: "pointer" }}
            onClick={() => {
              localStorage.setItem(LS_SITE_ID, siteId);
              localStorage.setItem(LS_TOKEN, token);
              setConnected(true);
            }}
            disabled={!token.trim() || !siteId.trim()}
          >
            Connect
          </button>
          {(localStorage.getItem(LS_TOKEN) ?? "") !== "" && (
            <p style={{ fontSize: "12px", color: "#666", margin: 0 }}>
              Credentials restored from previous session.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── 2. Guard: ClientSync not yet instantiated ─────────────────────────────
  if (!client) return null;

  // ── 3. Connecting / reconnecting (first attempt only, or mid-reconnect) ───
  // Show spinner only when there is no local text to display yet.
  if ((connectionState === "connecting" || connectionState === "reconnecting") && client.getText() === "" && queuedOps === 0) {
    return (
      <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <h2>Connecting to relay…</h2>
        <p>Establishing WebSocket connection…</p>
      </div>
    );
  }

  // ── 4. Offline / reconnecting banner ─────────────────────────────────────
  // The editor stays mounted and editable. Ops enqueue to IndexedDB via
  // ClientSync → drainOutbox → OfflineQueue, then flush automatically on reconnect.
  const isOffline = connectionState === "disconnected" || connectionState === "reconnecting";

  const offlineBanner = isOffline ? (
    <div
      data-testid="offline-banner"
      style={{
        background: "#fef3c7",
        borderBottom: "1px solid #f59e0b",
        padding: "6px 16px",
        fontSize: "13px",
        color: "#92400e",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        flexShrink: 0,
      }}
    >
      <span>⚠ Working offline — edits are saved locally and will sync automatically on reconnect.</span>
      {queuedOps > 0 && (
        <strong data-testid="banner-queued-count">
          {queuedOps} edit{queuedOps === 1 ? "" : "s"} queued
        </strong>
      )}
      {connectionState === "disconnected" && (
        <button
          onClick={() => setConnected(false)}
          style={{
            marginLeft: "auto",
            fontSize: "12px",
            padding: "2px 8px",
            cursor: "pointer",
            background: "transparent",
            border: "1px solid #92400e",
            borderRadius: "4px",
            color: "#92400e",
          }}
        >
          Change token
        </button>
      )}
    </div>
  ) : null;

  // ── Save button label ─────────────────────────────────────────────────────
  const saveLabel =
    saveStatus === "saving" ? "Saving…" :
    saveStatus === "saved"  ? "Saved ✓" :
    saveStatus === "error"  ? "Save failed!" :
    supportsFileSystemAccess ? "Save" : "Save ↓";

  // ── 5. Main editor layout ─────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "sans-serif" }}>
      {offlineBanner}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Editor column */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "1rem", gap: "0.5rem", minWidth: 0 }}>

          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #ccc", paddingBottom: "0.75rem", gap: "1rem" }}>
            <DocumentTitle client={client} metaVersion={metaVersion} />
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
              <PresenceBar presences={presences} localSiteId={siteId} />
              {/* queuedOps comes from OfflineQueue.size() — the engine's own queue */}
              <ConnectionStatus status={connectionState} queuedOps={queuedOps} />

              {/* Hidden fallback <input> for browsers without File System Access API */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt"
                style={{ display: "none" }}
                onChange={handleFallbackFileChange}
              />

              <button
                title="Open a local .txt file"
                onClick={() => { void handleOpenClick(); }}
                style={{ padding: "4px 8px", cursor: "pointer", fontSize: "12px" }}
              >
                Open ↑
              </button>

              <button
                title={supportsFileSystemAccess ? "Save to file (Ctrl+S)" : "Download as .txt (Ctrl+S)"}
                onClick={() => { void doSave(); }}
                style={{
                  padding: "4px 8px",
                  cursor: "pointer",
                  fontSize: "12px",
                  color: saveStatus === "error" ? "#c00" : saveStatus === "saved" ? "#080" : undefined,
                }}
              >
                {saveLabel}
              </button>

              {/* Offline toggle — disconnects WS but keeps editor mounted for offline demo */}
              {connectionState === "connected" && !manuallyOffline ? (
                <button
                  id="btn-go-offline"
                  title="Simulate going offline (keeps edits queued locally)"
                  onClick={handleGoOffline}
                  style={{ padding: "4px 10px", cursor: "pointer", fontSize: "12px", background: "transparent", border: "1px solid #ef4444", borderRadius: "4px", color: "#ef4444" }}
                >
                  Go Offline
                </button>
              ) : manuallyOffline ? (
                <button
                  id="btn-reconnect"
                  title="Reconnect to relay and flush queued edits"
                  onClick={() => { void handleReconnect(); }}
                  style={{ padding: "4px 10px", cursor: "pointer", fontSize: "12px", background: "#16a34a", border: "none", borderRadius: "4px", color: "#fff" }}
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          </header>

          {/* File path bar */}
          {openedFileName && (
            <div style={{ fontSize: "11px", color: "#666", paddingLeft: "2px", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span title="Current file">📄</span>
              <span style={{ fontFamily: "monospace" }}>{openedFileName}</span>
              {supportsFileSystemAccess && fileHandle && (
                <span style={{ color: "#aaa" }}>— edits save in place (Ctrl+S)</span>
              )}
            </div>
          )}

          <main style={{ flex: 1, overflow: "hidden" }}>
            <EditorView ref={editorRef} client={client} presences={presences} />
          </main>
        </div>

        {/* Sidebar */}
        <aside style={{ width: "300px", borderLeft: "1px solid #ccc", padding: "1rem", background: "#f9f9f9", overflowY: "auto" }}>
          <RoleManager client={client} localSiteId={siteId} peers={peers} />
        </aside>
      </div>
    </div>
  );
};
