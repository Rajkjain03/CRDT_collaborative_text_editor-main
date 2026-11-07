import { useState, useRef, useCallback, useEffect } from 'react';
import { Peer } from '../sim/Peer';
import type { EditorChange } from '../components/EditorPane';
import { serializeWireMessage, parseWireMessage } from '@collab-sync/shared/protocol.ts';
import type { WireMessage, JoinMessage, WelcomeMessage, OpMessage, MetaMessage, ErrorMessage, SiteJoinedMessage, SiteLeftMessage } from '@collab-sync/shared/protocol.ts';
import type { Role } from '@collab-sync/shared/roles.ts';

export type NetworkState = 'disconnected' | 'connecting' | 'connected' | 'error';

export function useNetworkClient() {
  const [networkState, setNetworkState] = useState<NetworkState>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Local peer state
  const peerRef = useRef<Peer | null>(null);
  const [siteId, setSiteId] = useState<string>('');
  const [role, setRole] = useState<Role | null>(null);
  
  // For the UI
  const [text, setText] = useState('');
  const [activeSites, setActiveSites] = useState<string[]>([]);
  
  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback((url: string, token: string) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    setNetworkState('connecting');
    setErrorMsg(null);
    
    // We will get siteId from WelcomeMessage, so we can't create Peer yet.
    // Wait, Peer requires a siteId in its constructor. We'll create it when we receive WelcomeMessage.

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send JoinMessage
      const joinMsg: JoinMessage = {
        kind: 'join',
        siteId: 'temporary-id', // The server will assign the actual site ID based on the token
        token,
        clientClock: {} // We start with an empty clock since we recreate the Peer
      };
      // Note: we might want to store siteId if we have persistence, but for now we let the token define it or we just use what Welcome gives.
      // Wait, the JoinMessage expects siteId. The server verifies if token matches.
      // If we don't know the siteId, wait, does the token encode the siteId? 
      // In roles.ts, token is payload base64 + signature. Payload has siteId.
      // But client might not easily decode it without a library (or standard atob).
      // Actually, we can just parse the JWT-like token.
      try {
        const base64Url = token.split('.')[0]!;
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        // Pad with = to make it a multiple of 4
        const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
        const payloadStr = atob(base64 + pad);
        const payload = JSON.parse(payloadStr);
        const assignedSiteId = payload.siteId;
        
        const initialJoin: JoinMessage = {
          kind: 'join',
          siteId: assignedSiteId,
          token,
          clientClock: {}
        };
        ws.send(serializeWireMessage(initialJoin));
      } catch (e) {
        setNetworkState('error');
        setErrorMsg('Invalid token format');
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      const msg = parseWireMessage(event.data);
      if (!msg) return;

      switch (msg.kind) {
        case 'welcome': {
          const welcome = msg as WelcomeMessage;
          setSiteId(welcome.assignedSiteId);
          setRole(welcome.role);
          setActiveSites(welcome.activeSites);
          setNetworkState('connected');
          
          // Initialize peer
          peerRef.current = new Peer(welcome.assignedSiteId);
          setText(peerRef.current.text);
          break;
        }
        case 'error': {
          const errorMsg = msg as ErrorMessage;
          setNetworkState('error');
          setErrorMsg(errorMsg.message);
          ws.close();
          break;
        }
        case 'site_joined': {
          const joined = msg as SiteJoinedMessage;
          setActiveSites(prev => [...new Set([...prev, joined.siteId])]);
          break;
        }
        case 'site_left': {
          const left = msg as SiteLeftMessage;
          setActiveSites(prev => prev.filter(id => id !== left.siteId));
          break;
        }
        case 'op': {
          const opMsg = msg as OpMessage;
          if (peerRef.current) {
            peerRef.current.receive(opMsg.op);
            peerRef.current.applyReady();
            setText(peerRef.current.text);
          }
          break;
        }
        case 'meta': {
          // Future: handle LWW metadata
          break;
        }
      }
    };

    ws.onerror = () => {
      setNetworkState('error');
      setErrorMsg('WebSocket error occurred');
    };

    ws.onclose = () => {
      setNetworkState('disconnected');
    };
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    peerRef.current = null;
    setNetworkState('disconnected');
    setSiteId('');
    setRole(null);
    setActiveSites([]);
    setText('');
  }, []);

  const handleLocalChange = useCallback((changes: EditorChange[]) => {
    if (!peerRef.current || networkState !== 'connected' || !wsRef.current) return false;
    
    let adjustment = 0;
    for (const change of changes) {
      const adjustedFrom = change.from + adjustment;
      const deleteCount = change.toA - change.from;

      for (let i = 0; i < deleteCount; i++) {
        peerRef.current.deleteAt(adjustedFrom);
      }
      adjustment -= deleteCount;

      const insertedText = change.inserted;
      for (let i = 0; i < insertedText.length; i++) {
        peerRef.current.insertAt(adjustedFrom + i, insertedText[i]!);
      }
      adjustment += insertedText.length;
    }

    // Flush outbox to WebSocket
    while (peerRef.current.outbox.length > 0) {
      const op = peerRef.current.outbox.shift()!;
      const opMsg: OpMessage = {
        kind: 'op',
        siteId: peerRef.current.siteId,
        op
      };
      wsRef.current.send(serializeWireMessage(opMsg));
    }
    
    setText(peerRef.current.text);
    return true;
  }, [networkState]);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    networkState,
    errorMsg,
    siteId,
    role,
    text,
    activeSites,
    connect,
    disconnect,
    handleLocalChange,
  };
}
