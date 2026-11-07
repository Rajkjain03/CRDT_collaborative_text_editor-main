import { useState, useRef, useCallback, useEffect } from 'react';
import { Scheduler, OpLogEntry } from '../sim/Scheduler';
import { Peer } from '../sim/Peer';

const PEER_NAMES = [
  'Alice', 'Bob', 'Carol', 'Dave', 'Eve',
  'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy',
];

export type PeerState = {
  siteId: string;
  name: string;
  text: string;
  pendingOps: number;
  totalNodes: number;
  isPartitioned: boolean;
};

export function useCRDTSimulator() {
  const schedulerRef = useRef(new Scheduler());
  const [peerStates, setPeerStates] = useState<PeerState[]>([]);
  const [autoSync, setAutoSync] = useState(true);
  const [converged, setConverged] = useState(true);
  const [opLog, setOpLog] = useState<OpLogEntry[]>([]);
  const [pendingMessages, setPendingMessages] = useState(0);
  const nextPeerIndex = useRef(0);

  // Refresh peer states from the scheduler
  const refreshStates = useCallback(() => {
    const scheduler = schedulerRef.current;
    const states: PeerState[] = [];
    for (const [siteId, peer] of scheduler.peers) {
      states.push({
        siteId,
        name: siteId,
        text: peer.text,
        pendingOps: peer.pendingCount,
        totalNodes: peer.doc.totalNodeCount,
        isPartitioned: scheduler.isPartitioned(siteId),
      });
    }
    setPeerStates(states);
    setPendingMessages(scheduler.pendingMessageCount);
    const { converged: c } = scheduler.checkConvergence();
    setConverged(c);
    setOpLog([...scheduler.opLog].slice(-100)); // last 100 entries
  }, []);

  // Add a peer
  const addPeer = useCallback(() => {
    const scheduler = schedulerRef.current;
    if (scheduler.peers.size >= 10) return;
    const name = PEER_NAMES[nextPeerIndex.current % PEER_NAMES.length]!;
    nextPeerIndex.current++;
    // Ensure unique name
    const existing = new Set(scheduler.peers.keys());
    let uniqueName = name;
    let suffix = 2;
    while (existing.has(uniqueName)) {
      uniqueName = `${name}${suffix++}`;
    }
    scheduler.addPeer(uniqueName);
    refreshStates();
  }, [refreshStates]);

  // Remove a peer
  const removePeer = useCallback((siteId: string) => {
    schedulerRef.current.removePeer(siteId);
    refreshStates();
  }, [refreshStates]);

  // Handle a local edit from a peer's editor
  const handleLocalChange = useCallback((siteId: string, changes: { from: number; toA: number; inserted: string }[]) => {
    const scheduler = schedulerRef.current;
    const peer = scheduler.peers.get(siteId);
    if (!peer) return;

    // Apply changes to the CRDT
    let adjustment = 0;
    for (const change of changes) {
      const adjustedFrom = change.from + adjustment;
      const deleteCount = change.toA - change.from;

      // Delete characters (at the same position repeatedly)
      for (let i = 0; i < deleteCount; i++) {
        peer.deleteAt(adjustedFrom);
      }
      adjustment -= deleteCount;

      // Insert characters
      const insertedText = change.inserted;
      for (let i = 0; i < insertedText.length; i++) {
        peer.insertAt(adjustedFrom + i, insertedText[i]!);
      }
      adjustment += insertedText.length;
    }

    // If auto-sync, deliver immediately
    if (autoSync) {
      const changedPeers = scheduler.sync();
      refreshStates();
      return changedPeers;
    } else {
      scheduler.collectOutboxes();
      refreshStates();
      return new Set<string>();
    }
  }, [autoSync, refreshStates]);

  // Manual sync
  const syncNow = useCallback(() => {
    const changedPeers = schedulerRef.current.sync();
    refreshStates();
    return changedPeers;
  }, [refreshStates]);

  // Toggle partition
  const togglePartition = useCallback((siteId: string) => {
    const scheduler = schedulerRef.current;
    if (scheduler.isPartitioned(siteId)) {
      scheduler.healPeer(siteId);
    } else {
      scheduler.partitionPeer(siteId);
    }
    refreshStates();
  }, [refreshStates]);

  // Toggle auto-sync
  const toggleAutoSync = useCallback(() => {
    setAutoSync(prev => !prev);
  }, []);

  // Get a peer instance
  const getPeer = useCallback((siteId: string): Peer | undefined => {
    return schedulerRef.current.peers.get(siteId);
  }, []);

  // Initialize with 3 peers
  useEffect(() => {
    addPeer();
    addPeer();
    addPeer();
  }, []);

  return {
    peerStates,
    autoSync,
    converged,
    opLog,
    pendingMessages,
    addPeer,
    removePeer,
    handleLocalChange,
    syncNow,
    togglePartition,
    toggleAutoSync,
    getPeer,
    refreshStates,
  };
}
