import { useState, useRef, useCallback, useEffect } from 'react';
import Header from './components/Header';
import EditorPane from './components/EditorPane';
import { useNetworkClient } from './hooks/useNetworkClient';
import type { EditorPaneHandle, EditorChange } from './components/EditorPane';

export default function NetworkApp({ onBack }: { onBack: () => void }) {
  const {
    networkState,
    errorMsg,
    siteId,
    role,
    text,
    activeSites,
    connect,
    disconnect,
    handleLocalChange,
  } = useNetworkClient();

  const [url, setUrl] = useState('ws://localhost:8080');
  const [token, setToken] = useState('');
  
  const editorRef = useRef<EditorPaneHandle>(null);

  // Sync text to editor when remote changes happen
  useEffect(() => {
    if (editorRef.current && text !== undefined) {
      // Note: we might only want to apply remote text if it's different to prevent resetting cursor.
      // EditorPane handles cursor preservation reasonably well if we just apply the full text for now.
      editorRef.current.applyRemoteText(text);
    }
  }, [text]);

  const onEditorChange = useCallback((changes: EditorChange[]) => {
    handleLocalChange(changes);
  }, [handleLocalChange]);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (token && url) {
      connect(url, token);
    }
  };

  return (
    <div className="app network-app">
      <Header />
      
      <div style={{ padding: '10px 20px', background: '#2c3e50', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <button onClick={onBack} style={{ marginRight: '15px', padding: '5px 10px' }}>&larr; Back to Simulator</button>
          <span style={{ fontWeight: 'bold' }}>Network Collaboration Mode</span>
        </div>
        <div style={{ fontSize: '0.9em' }}>
          Status: <strong style={{ color: networkState === 'connected' ? '#2ecc71' : networkState === 'error' ? '#e74c3c' : '#f1c40f' }}>{networkState.toUpperCase()}</strong>
        </div>
      </div>

      <main className="main-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px' }}>
        
        {networkState !== 'connected' && (
          <div style={{ background: '#ecf0f1', padding: '30px', borderRadius: '8px', width: '100%', maxWidth: '500px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginTop: 0, marginBottom: '20px' }}>Join a Session</h2>
            <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Relay Server URL</label>
                <input 
                  type="text" 
                  value={url} 
                  onChange={e => setUrl(e.target.value)}
                  style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                  placeholder="ws://localhost:8080"
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Session Token</label>
                <input 
                  type="text" 
                  value={token} 
                  onChange={e => setToken(e.target.value)}
                  style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                  placeholder="Paste Owner, Editor, or Viewer token here"
                />
              </div>
              {errorMsg && (
                <div style={{ color: '#e74c3c', padding: '10px', background: '#fadbd8', borderRadius: '4px' }}>
                  {errorMsg}
                </div>
              )}
              <button type="submit" disabled={!url || !token || networkState === 'connecting'} style={{ padding: '10px', background: '#3498db', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1em' }}>
                {networkState === 'connecting' ? 'Connecting...' : 'Connect'}
              </button>
            </form>
          </div>
        )}

        {networkState === 'connected' && (
          <div style={{ display: 'flex', width: '100%', maxWidth: '1200px', gap: '20px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, background: 'white', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '10px 15px', background: '#f8f9fa', borderBottom: '1px solid #dee2e6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: '1.1em' }}>My Editor</strong>
                  <span style={{ marginLeft: '10px', fontSize: '0.85em', background: '#e9ecef', padding: '2px 8px', borderRadius: '12px' }}>Role: {role}</span>
                </div>
                <div style={{ fontSize: '0.85em', color: '#6c757d' }}>
                  Site ID: {siteId.substring(0, 8)}...
                </div>
              </div>
              <div style={{ height: '600px' }}>
                <EditorPane 
                  ref={editorRef}
                  initialText={text}
                  onChange={onEditorChange}
                  readOnly={role === 'viewer'}
                />
              </div>
            </div>
            
            <div style={{ width: '250px', background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, borderBottom: '1px solid #eee', paddingBottom: '10px' }}>Active Peers ({activeSites.length})</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {activeSites.map(id => (
                  <li key={id} style={{ padding: '8px 0', borderBottom: '1px solid #f1f1f1', fontSize: '0.9em', display: 'flex', alignItems: 'center' }}>
                    <span style={{ width: '8px', height: '8px', background: '#2ecc71', borderRadius: '50%', display: 'inline-block', marginRight: '8px' }}></span>
                    {id === siteId ? <strong>{id.substring(0, 8)} (You)</strong> : id.substring(0, 8)}
                  </li>
                ))}
              </ul>
              
              <button 
                onClick={disconnect}
                style={{ marginTop: '20px', width: '100%', padding: '8px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
