import type { OpLogEntry } from '../sim/Scheduler';

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
  if (PEER_COLORS[name]) return PEER_COLORS[name];
  const base = name.replace(/\d+$/, '');
  return PEER_COLORS[base] || '#94a3b8';
}

type OperationLogProps = {
  entries: OpLogEntry[];
};

export default function OperationLog({ entries }: OperationLogProps) {
  const recent = entries.slice(-50).reverse();

  return (
    <div className="operation-log">
      <div className="log-header">
        <span className="log-title">📡 Operation Log</span>
        <span className="log-count">{entries.length} ops</span>
      </div>
      <div className="log-entries">
        {recent.length === 0 ? (
          <div className="log-empty">No operations yet. Start typing!</div>
        ) : (
          recent.map((entry) => (
            <div key={entry.id} className="log-entry">
              <span
                className="log-dot"
                style={{ backgroundColor: getColor(entry.from) }}
              />
              <span className="log-from" style={{ color: getColor(entry.from) }}>
                {entry.from}
              </span>
              <span className="log-arrow">→</span>
              <span className="log-to" style={{ color: getColor(entry.to) }}>
                {entry.to}
              </span>
              <span className={`log-type ${entry.opType}`}>
                {entry.opType === 'insert' ? `INS '${entry.char}'` : 'DEL'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
