import { useEffect, useRef, useState } from "react";
import { ClientSync } from "collab-sync";
import type { ConnectionState, Role } from "collab-sync";
import type { SiteId } from "crdt-engine";

export interface PeerInfo {
  role: Role;
  /** Unix-ms timestamp from the peer's last heartbeat. 0 = not yet received. */
  lastHb: number;
}

export interface CollabClientState {
  client: ClientSync | null;
  connectionState: ConnectionState;
  /** Connected peers excluding the local site. Updated via onWelcome / onSiteJoined / onSiteLeft. */
  peers: Map<SiteId, PeerInfo>;
  /**
   * Monotonically-incrementing counter that bumps whenever any LWW meta field
   * changes. usePresence and DocumentTitle useEffect on this to re-read LWW
   * state without wiring their own onMetaChanged handlers.
   */
  metaVersion: number;
}

export function useCollabClient(
  siteId: string,
  serverUrl: string,
  token: string,
  shouldConnect: boolean,
): CollabClientState {
  const [client, setClient] = useState<ClientSync | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [peers, setPeers] = useState<Map<SiteId, PeerInfo>>(new Map());
  const [metaVersion, setMetaVersion] = useState(0);

  // Keep a ref to peers so the onMetaChanged closure can read the latest value
  // without stale-capture issues.
  const peersRef = useRef<Map<SiteId, PeerInfo>>(peers);
  peersRef.current = peers;

  useEffect(() => {
    if (!shouldConnect) return;

    const newClient = new ClientSync(siteId, serverUrl, token);

    // ── Initial peer roster (from WelcomeMessage) ──────────────────────────
    newClient.onWelcome = (activeSites) => {
      const initial = new Map<SiteId, PeerInfo>();
      for (const { siteId: peerId, role } of activeSites) {
        initial.set(peerId, { role, lastHb: 0 });
      }
      setPeers(initial);
    };

    // ── Connection state ───────────────────────────────────────────────────
    newClient.onConnectionChange = (state) => {
      setConnectionState(state);
    };

    // ── Peer join / leave ──────────────────────────────────────────────────
    newClient.onSiteJoined = (peerId, role) => {
      setPeers((prev) => {
        const next = new Map(prev);
        next.set(peerId, { role, lastHb: prev.get(peerId)?.lastHb ?? 0 });
        return next;
      });
    };

    newClient.onSiteLeft = (peerId) => {
      setPeers((prev) => {
        const next = new Map(prev);
        next.delete(peerId);
        return next;
      });
    };

    // ── Meta changes (single handler — no more chaining) ──────────────────
    newClient.onMetaChanged = (changed) => {
      // Update heartbeat timestamps for peers who sent hb:<siteId> meta.
      const hbUpdates: Array<{ peerId: SiteId; ts: number }> = [];
      for (const update of changed) {
        if (update.field.startsWith("hb:")) {
          const peerId = update.field.substring(3);
          hbUpdates.push({ peerId, ts: update.value as number });
        }
      }
      if (hbUpdates.length > 0) {
        setPeers((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const { peerId, ts } of hbUpdates) {
            const existing = next.get(peerId);
            if (existing) {
              next.set(peerId, { ...existing, lastHb: ts });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      // Bump metaVersion so usePresence / DocumentTitle re-read LWW state.
      setMetaVersion((v) => v + 1);
    };

    setClient(newClient);

    newClient.connect().then(() => {
      setConnectionState("connected");
    }).catch((err) => {
      console.error("Connect failed:", err);
      setConnectionState("disconnected");
    });

    return () => {
      newClient.onWelcome = null;
      newClient.onConnectionChange = null;
      newClient.onSiteJoined = null;
      newClient.onSiteLeft = null;
      newClient.onMetaChanged = null;
      newClient.close();
      setClient(null);
      setPeers(new Map());
      setConnectionState("disconnected");
    };
  }, [siteId, serverUrl, token, shouldConnect]);

  return { client, connectionState, peers, metaVersion };
}
