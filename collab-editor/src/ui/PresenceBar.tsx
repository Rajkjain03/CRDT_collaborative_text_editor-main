import React from "react";
import { SiteId } from "crdt-engine";
import { SelectionPresence } from "../bridge/presence";

// A simple hashing function to generate a consistent color from a string
const getDeterministicColor = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Use HSL to ensure the color is always dark enough for white text to be readable
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 40%)`; 
};

export const PresenceBar: React.FC<{ 
  presences: Map<SiteId, SelectionPresence>;
  localSiteId?: SiteId; 
}> = ({ presences, localSiteId }) => {
  
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      {Array.from(presences.keys()).map(siteId => {
        const isLocal = siteId === localSiteId;
        const color = getDeterministicColor(siteId);
        
        return (
          <span 
            key={siteId} 
            data-testid={`avatar-${siteId}`}
            style={{ 
              background: color, 
              color: "#fff", 
              padding: "4px 8px", 
              borderRadius: "12px", 
              fontSize: "12px" 
            }}>
            {siteId} {isLocal && <strong data-testid="you-indicator">(You)</strong>}
          </span>
        );
      })}
    </div>
  );
};