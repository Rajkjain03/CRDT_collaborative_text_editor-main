import React from "react";

export interface ConnectionStatusProps {
  status: "connected" | "disconnected" | "connecting" | "reconnecting";
  /** Number of ops currently held in the offline queue (0 when connected). */
  queuedOps?: number;
  attemptCount?: number;
}

// Keyframe animation injected once
const PULSE_STYLE_ID = "collab-status-pulse";
if (typeof document !== "undefined" && !document.getElementById(PULSE_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = PULSE_STYLE_ID;
  style.textContent = `
    @keyframes collab-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.35; }
    }
    .collab-dot-pulse { animation: collab-pulse 1.2s ease-in-out infinite; }
  `;
  document.head.appendChild(style);
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  status,
  queuedOps = 0,
  attemptCount,
}) => {
  const isOffline = status === "disconnected" || status === "reconnecting";
  const isConnecting = status === "connecting" || status === "reconnecting";

  let dotColor = "#ef4444";   // red
  let label = "Offline";

  switch (status) {
    case "connected":
      dotColor = "#22c55e";   // green
      label = "Online";
      break;
    case "connecting":
      dotColor = "#eab308";   // yellow
      label = "Connecting…";
      break;
    case "reconnecting":
      dotColor = "#f97316";   // orange
      label = attemptCount ? `Reconnecting (${attemptCount})…` : "Reconnecting…";
      break;
    case "disconnected":
      dotColor = "#ef4444";
      label = "Offline";
      break;
  }

  return (
    <div
      data-testid="connection-status-root"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        userSelect: "none",
      }}
    >
      {/* Pulsing dot */}
      <div
        data-testid="status-indicator"
        className={isConnecting ? "collab-dot-pulse" : undefined}
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />

      <span style={{ color: isOffline ? "#b45309" : "inherit" }}>{label}</span>

      {/* Queued-ops badge — only shown while offline and ops are pending */}
      {isOffline && queuedOps > 0 && (
        <span
          data-testid="queued-ops-badge"
          title={`${queuedOps} edit${queuedOps === 1 ? "" : "s"} will sync when back online`}
          style={{
            backgroundColor: "#f97316",
            color: "#fff",
            borderRadius: "999px",
            padding: "1px 7px",
            fontSize: "11px",
            fontWeight: 600,
            lineHeight: "1.6",
            cursor: "default",
          }}
        >
          {queuedOps} queued
        </span>
      )}

      {/* "Synced" flash right after reconnect drains the queue */}
      {status === "connected" && queuedOps === 0 && (
        <span
          style={{ color: "#22c55e", fontSize: "11px", fontWeight: 500 }}
        >
          ✓ synced
        </span>
      )}
    </div>
  );
};
