import { useRef, useCallback } from 'react';
import EditorPane, { EditorPaneHandle, EditorChange } from './EditorPane';

const PEER_COLORS: Record<string, string> = {
  Alice: '#a78bfa',
  Bob: '#22d3ee',
  Carol: '#fbbf24',
  Dave: '#f87171',
  Eve: '#34d399',
  Frank: '#fb923c',
  Grace: '#e879f9',
  Heidi: '#38bdf8',
  Ivan: '#a3e635',
  Judy: '#f472b6',
};

function getColor(name: string): string {
  // Try exact match first, then strip numbers
  if (PEER_COLORS[name]) return PEER_COLORS[name];
  const base = name.replace(/\d+$/, '');
  return PEER_COLORS[base] || '#94a3b8';
}

type PeerPanelProps = {
  siteId: string;
  name: string;
  text: string;
  pendingOps: number;
  totalNodes: number;
  isPartitioned: boolean;
  canRemove: boolean;
  onLocalChange: (siteId: string, changes: EditorChange[]) => Set<string> | undefined;
  onTogglePartition: (siteId: string) => void;
  onRemove: (siteId: string) => void;
  editorRef: React.RefObject<EditorPaneHandle | null>;
};

export default function PeerPanel({
  siteId,
  name,
  pendingOps,
  totalNodes,
  isPartitioned,
  canRemove,
  onLocalChange,
  onTogglePartition,
  onRemove,
  editorRef,
}: PeerPanelProps) {
  const color = getColor(name);

  const handleLocalChange = useCallback(
    (changes: EditorChange[]) => {
      onLocalChange(siteId, changes);
    },
    [siteId, onLocalChange]
  );

  return (
    <div
      className={`peer-panel ${isPartitioned ? 'partitioned' : ''}`}
      style={{ '--peer-color': color } as React.CSSProperties}
    >
      <div className="peer-header">
        <div className="peer-identity">
          <span className="peer-dot" style={{ backgroundColor: color }} />
          <span className="peer-name">{name}</span>
          {isPartitioned && <span className="partition-badge">OFFLINE</span>}
        </div>
        <div className="peer-actions">
          <button
            className={`peer-btn ${isPartitioned ? 'heal' : 'partition'}`}
            onClick={() => onTogglePartition(siteId)}
            title={isPartitioned ? 'Reconnect' : 'Disconnect'}
          >
            {isPartitioned ? '🔗' : '✂️'}
          </button>
          {canRemove && (
            <button
              className="peer-btn remove"
              onClick={() => onRemove(siteId)}
              title="Remove peer"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="peer-editor-wrap">
        <EditorPane
          ref={editorRef}
          accentColor={color}
          onLocalChange={handleLocalChange}
          disabled={isPartitioned}
        />
      </div>

      <div className="peer-stats">
        <span className="stat">
          <span className="stat-label">Nodes</span>
          <span className="stat-value">{totalNodes}</span>
        </span>
        <span className="stat">
          <span className="stat-label">Buffered</span>
          <span className="stat-value">{pendingOps}</span>
        </span>
      </div>
    </div>
  );
}
