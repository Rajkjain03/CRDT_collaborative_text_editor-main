import React, { useState, useEffect } from "react";
import { ClientSync } from "collab-sync";
import { SiteId } from "crdt-engine";
import type { PeerInfo } from "../hooks/useCollabClient";

// Heartbeat staleness thresholds (ms).
const HB_FRESH_MS = 15_000;  // < 15 s  → green (active)
const HB_STALE_MS = 30_000;  // < 30 s  → yellow (slow)
// ≥ 30 s or no heartbeat → red (unknown)

function heartbeatDot(lastHb: number): React.ReactNode {
  const age = lastHb === 0 ? Infinity : Date.now() - lastHb;
  const color = age < HB_FRESH_MS ? "#22c55e" : age < HB_STALE_MS ? "#eab308" : "#ef4444";
  const label = age < HB_FRESH_MS ? "active" : age < HB_STALE_MS ? "slow" : "unknown";
  return (
    <span
      title={`heartbeat: ${label}`}
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        backgroundColor: color,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

export const RoleManager: React.FC<{
  client: ClientSync;
  localSiteId: string;
  peers: Map<SiteId, PeerInfo>;
}> = ({ client, localSiteId, peers }) => {
  const [newSiteId, setNewSiteId] = useState("");
  const [selectedRole, setSelectedRole] = useState("editor");
  const [tokenResult, setTokenResult] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Force re-render every 5 s so heartbeat dots stay fresh.
  const [, setTick] = useState(0);

  const role = client.getRole ? client.getRole() : null;
  const activePeerIds = Array.from(peers.keys());

  useEffect(() => {
    if (tokenResult) {
      const timer = setTimeout(() => {
        setTokenResult("");
        setCopied(false);
      }, 30000);
      return () => clearTimeout(timer);
    }
  }, [tokenResult]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const handleMint = async () => {
    setError("");
    setTokenResult("");
    setCopied(false);

    if (!newSiteId.trim()) {
      setError("Site ID cannot be empty.");
      return;
    }

    try {
      const t = await client.mintToken(newSiteId, selectedRole as any);
      setTokenResult(t);
    } catch (e: any) {
      setError(e.message || "Failed to mint token.");
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(tokenResult);
      setCopied(true);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  return (
    <div style={{ padding: "12px", background: "#f0f0f0", marginTop: "8px", borderRadius: "6px", overflowWrap: "anywhere" }}>
      <h3 style={{ marginTop: 0 }}>Session Info</h3>

      <p style={{ marginBottom: "4px" }}>Site ID: <strong>{localSiteId}</strong></p>
      <p style={{ marginTop: 0 }}>Role: <strong style={{ textTransform: "capitalize" }}>{role || "Waiting..."}</strong></p>

      {/* Connected peers — visible to everyone */}
      <div style={{ marginTop: "12px" }}>
        <label style={{ fontWeight: "bold", fontSize: "13px" }}>Connected Peers:</label>
        {activePeerIds.length === 0 ? (
          <p style={{ color: "#888", fontSize: "12px", margin: "4px 0" }}>No other peers connected.</p>
        ) : (
          <ul style={{ margin: "6px 0", padding: "0 0 0 4px", listStyle: "none" }}>
            {activePeerIds.map((peerId) => {
              const info = peers.get(peerId)!;
              return (
                <li key={peerId} style={{ display: "flex", alignItems: "center", fontSize: "13px", marginBottom: "4px" }}>
                  {heartbeatDot(info.lastHb)}
                  <span>
                    <strong>{peerId}</strong>{" "}
                    <span style={{ color: "#666", textTransform: "capitalize" }}>({info.role})</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {role === "owner" && (
        <div data-testid="owner-tools" style={{ marginTop: "15px", display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid #ccc", paddingTop: "15px" }}>
          <label style={{ fontWeight: "bold" }}>Mint Token for Peer:</label>

          <select
            value={newSiteId}
            onChange={(e) => setNewSiteId(e.target.value)}
            style={{ padding: "6px" }}
          >
            <option value="" disabled>-- Select Connected Peer --</option>
            {activePeerIds.map((peerId) => (
              <option key={peerId} value={peerId}>{peerId}</option>
            ))}
          </select>

          <input
            value={newSiteId}
            onChange={(e) => setNewSiteId(e.target.value)}
            placeholder="Or type Site ID..."
            style={{ padding: "6px" }}
          />
          <select
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            style={{ padding: "6px" }}
          >
            <option value="editor">Make Editor</option>
            <option value="viewer">Make Viewer</option>
          </select>
          <button
            onClick={handleMint}
            disabled={!newSiteId.trim()}
            style={{ cursor: "pointer", padding: "8px", background: newSiteId.trim() ? "#007bff" : "#ccc", color: "white", border: "none", borderRadius: "4px" }}
          >
            Create Token
          </button>
          {error && <div style={{ color: "red", fontSize: "12px", marginTop: "4px" }}>{error}</div>}
        </div>
      )}

      {tokenResult && (
        <div style={{ marginTop: "15px", fontSize: "12px", background: "#fff", padding: "10px", border: "1px solid #ccc", borderRadius: "4px" }}>
          <strong style={{ color: "green" }}>Token for {newSiteId}:</strong><br />
          <code style={{ userSelect: "all", display: "block", marginTop: "5px", marginBottom: "8px", wordBreak: "break-all" }}>{tokenResult}</code>
          <button onClick={copyToClipboard} style={{ cursor: "pointer", padding: "4px 8px" }}>
            {copied ? "Copied!" : "Copy to Clipboard"}
          </button>
        </div>
      )}
    </div>
  );
};
