type NetworkControlsProps = {
  autoSync: boolean;
  converged: boolean;
  pendingMessages: number;
  peerCount: number;
  onToggleAutoSync: () => void;
  onSyncNow: () => Set<string>;
  onAddPeer: () => void;
};

export default function NetworkControls({
  autoSync,
  converged,
  pendingMessages,
  peerCount,
  onToggleAutoSync,
  onSyncNow,
  onAddPeer,
}: NetworkControlsProps) {
  return (
    <div className="network-controls">
      <div className="controls-left">
        <button
          className={`control-btn sync-toggle ${autoSync ? 'active' : ''}`}
          onClick={onToggleAutoSync}
        >
          <span className="btn-icon">{autoSync ? '⚡' : '⏸'}</span>
          <span className="btn-label">{autoSync ? 'Auto-Sync ON' : 'Auto-Sync OFF'}</span>
        </button>

        <button
          className="control-btn sync-now"
          onClick={() => onSyncNow()}
          disabled={autoSync && pendingMessages === 0}
        >
          <span className="btn-icon">🔄</span>
          <span className="btn-label">Sync Now</span>
          {pendingMessages > 0 && (
            <span className="badge">{pendingMessages}</span>
          )}
        </button>

        <button
          className="control-btn add-peer"
          onClick={onAddPeer}
          disabled={peerCount >= 10}
        >
          <span className="btn-icon">➕</span>
          <span className="btn-label">Add Peer</span>
          <span className="badge">{peerCount}/10</span>
        </button>
      </div>

      <div className="controls-right">
        <div className={`convergence-indicator ${converged ? 'converged' : 'diverged'}`}>
          <span className="indicator-dot" />
          <span className="indicator-text">
            {converged ? 'All Peers Converged' : 'Diverged'}
          </span>
        </div>
      </div>
    </div>
  );
}
