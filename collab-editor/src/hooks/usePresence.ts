import { useEffect, useState } from "react";
import { ClientSync, SiteId } from "collab-sync";
import { SelectionPresence } from "../bridge/presence";

/**
 * Derives the cursor-presence map from the LWW state whenever metaVersion
 * changes. metaVersion is bumped by useCollabClient's onMetaChanged handler,
 * which is the single owner of the client.onMetaChanged slot.
 */
export function usePresence(
  client: ClientSync | null,
  metaVersion: number,
): Map<SiteId, SelectionPresence> {
  const [presenceMap, setPresenceMap] = useState<Map<SiteId, SelectionPresence>>(new Map());

  useEffect(() => {
    if (!client) {
      setPresenceMap(new Map());
      return;
    }

    const state = client.replica.lww.snapshot();
    const newMap = new Map<SiteId, SelectionPresence>();

    for (const [key, record] of Object.entries(state)) {
      if (key.startsWith("cursor:")) {
        const siteId = key.substring("cursor:".length);
        if (siteId !== client.siteId) {
          newMap.set(siteId, (record as { value: unknown }).value as SelectionPresence);
        }
      }
    }
    setPresenceMap(newMap);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, metaVersion]);

  return presenceMap;
}
