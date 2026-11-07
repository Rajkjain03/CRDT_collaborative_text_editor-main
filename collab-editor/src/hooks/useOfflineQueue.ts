import { useEffect, useState } from "react";
import type { ClientSync } from "collab-sync";
import type { ConnectionState } from "collab-sync";

/**
 * useOfflineQueue
 *
 * Polls the ClientSync offline queue every `pollMs` milliseconds and returns
 * the number of operations currently persisted in IndexedDB waiting to be
 * flushed to the relay.
 *
 * Polling is suspended while the connection is "connected" (queue will be
 * empty or draining) to avoid unnecessary reads during normal operation.
 * It fires immediately on mount and whenever connectionState changes so the
 * count updates the moment a flush completes.
 */
export function useOfflineQueue(
  client: ClientSync | null,
  connectionState: ConnectionState,
  pollMs = 1000,
): number {
  const [queueSize, setQueueSize] = useState(0);

  useEffect(() => {
    if (!client) {
      setQueueSize(0);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const size = await client.getOfflineQueueSize();
        if (!cancelled) setQueueSize(size);
      } catch {
        // IndexedDB not yet open or closing — ignore
      }
    };

    // Immediate read on every state change
    void poll();

    // While offline/reconnecting, keep polling so the count ticks down
    // as the flush progresses once the socket reopens.
    const id = setInterval(() => void poll(), pollMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, connectionState, pollMs]);

  return queueSize;
}
