import { useRef, useCallback } from 'react';
import Header from './components/Header';
import NetworkControls from './components/NetworkControls';
import PeerPanel from './components/PeerPanel';
import OperationLog from './components/OperationLog';
import { useCRDTSimulator } from './hooks/useCRDTSimulator';
import type { EditorPaneHandle, EditorChange } from './components/EditorPane';

export default function SimulatorApp({ onSwitchMode }: { onSwitchMode: () => void }) {
  const {
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
  } = useCRDTSimulator();

  const editorRefs = useRef<Map<string, React.RefObject<EditorPaneHandle | null>>>(new Map());

  const getEditorRef = useCallback((siteId: string) => {
    if (!editorRefs.current.has(siteId)) {
      editorRefs.current.set(siteId, { current: null });
    }
    return editorRefs.current.get(siteId)!;
  }, []);

  for (const key of editorRefs.current.keys()) {
    if (!peerStates.find((p) => p.siteId === key)) {
      editorRefs.current.delete(key);
    }
  }

  const onLocalChange = useCallback(
    (siteId: string, changes: EditorChange[]) => {
      const changedPeers = handleLocalChange(siteId, changes);
      if (changedPeers) {
        for (const changedId of changedPeers) {
          const peer = getPeer(changedId);
          const ref = editorRefs.current.get(changedId);
          if (peer && ref?.current) {
            ref.current.applyRemoteText(peer.text);
          }
        }
      }
      return changedPeers;
    },
    [handleLocalChange, getPeer]
  );

  const onSyncNow = useCallback(() => {
    const changedPeers = syncNow();
    for (const changedId of changedPeers) {
      const peer = getPeer(changedId);
      const ref = editorRefs.current.get(changedId);
      if (peer && ref?.current) {
        ref.current.applyRemoteText(peer.text);
      }
    }
    return changedPeers;
  }, [syncNow, getPeer]);

  const peerCount = peerStates.length;
  let gridCols = 'repeat(3, 1fr)';
  if (peerCount <= 2) gridCols = 'repeat(2, 1fr)';
  else if (peerCount <= 3) gridCols = 'repeat(3, 1fr)';
  else if (peerCount <= 4) gridCols = 'repeat(2, 1fr)';
  else if (peerCount <= 6) gridCols = 'repeat(3, 1fr)';
  else if (peerCount <= 8) gridCols = 'repeat(4, 1fr)';
  else gridCols = 'repeat(5, 1fr)';

  return (
    <div className="app">
      <Header />

      <div style={{ padding: '10px 20px', background: '#f1c40f', color: '#333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold' }}>Local Multi-Peer Simulator</span>
        <button 
          onClick={onSwitchMode}
          style={{ padding: '5px 15px', background: '#34495e', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          Switch to Network Mode &rarr;
        </button>
      </div>

      <NetworkControls
        autoSync={autoSync}
        converged={converged}
        pendingMessages={pendingMessages}
        peerCount={peerCount}
        onToggleAutoSync={toggleAutoSync}
        onSyncNow={onSyncNow}
        onAddPeer={addPeer}
      />

      <main className="main-content">
        <div
          className="peers-grid"
          style={{ gridTemplateColumns: gridCols }}
        >
          {peerStates.map((ps) => (
            <PeerPanel
              key={ps.siteId}
              siteId={ps.siteId}
              name={ps.name}
              text={ps.text}
              pendingOps={ps.pendingOps}
              totalNodes={ps.totalNodes}
              isPartitioned={ps.isPartitioned}
              canRemove={peerCount > 2}
              onLocalChange={onLocalChange}
              onTogglePartition={togglePartition}
              onRemove={removePeer}
              editorRef={getEditorRef(ps.siteId)}
            />
          ))}
        </div>

        <OperationLog entries={opLog} />
      </main>
    </div>
  );
}
