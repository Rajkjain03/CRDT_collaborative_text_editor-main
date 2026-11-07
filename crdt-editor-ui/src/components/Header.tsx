export default function Header() {
  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-left">
          <div className="logo">
            <span className="logo-icon">◇</span>
            <h1 className="logo-text">CRDT Editor</h1>
          </div>
          <p className="tagline">
            Real-time collaborative editing with Conflict-free Replicated Data Types
          </p>
        </div>
        <div className="header-right">
          <a
            href="https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type"
            target="_blank"
            rel="noopener noreferrer"
            className="header-link"
          >
            What is CRDT?
          </a>
        </div>
      </div>
    </header>
  );
}
