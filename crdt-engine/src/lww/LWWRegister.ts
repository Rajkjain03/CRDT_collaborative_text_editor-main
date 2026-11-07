/**
 * crdt-engine/src/lww/LWWRegister.ts — Last-Write-Wins register for metadata.
 *
 * Stores a flat key→value map where each entry carries a (timestamp, siteId)
 * pair for conflict resolution. On merge, the entry with the higher timestamp
 * wins; ties are broken by the lexicographically higher siteId.
 *
 * Used by Replica to synchronise document metadata (title, presence, roles)
 * across sites. The full state snapshot is broadcast as a MetaMessage so
 * every site converges to the same values regardless of delivery order.
 *
 * LWW is appropriate here because metadata fields are low-frequency and
 * last-writer semantics are acceptable (no "merge both" requirement).
 */

import { SiteId, LWWUpdate } from '../types';

/**
 * Full state snapshot of the register: a map from field name to the
 * winning (value, timestamp, siteId) triple. Sent over the wire as a
 * MetaMessage so peers can merge it into their own register.
 */
export type LWWState<T> = Record<string, { value: T; timestamp: number; siteId: SiteId }>;

export class LWWRegister<T> {
    private entries: Map<string, { value: T; timestamp: number; siteId: SiteId }>;

    /** @param initial  Optional starting state (e.g. when constructing from a snapshot). */
    constructor(initial?: LWWState<T>) {
        this.entries = new Map();
        if (initial) {
            for (const [field, entry] of Object.entries(initial)) {
                this.entries.set(field, entry);
            }
        }
    }

    /**
     * Read the current winning value for a field.
     * Returns undefined if the field has never been set.
     */
    get(field: string): T | undefined {
        return this.entries.get(field)?.value;
    }

    /**
     * Write a field locally and return an LWWUpdate for broadcast.
     *
     * Applies the write locally only if it wins the LWW conflict check
     * (higher timestamp, or same timestamp with higher siteId). Always
     * returns the update object so the caller can broadcast it regardless.
     *
     * @param field      The metadata field name.
     * @param value      The new value.
     * @param timestamp  Unix ms. Callers should use Date.now().
     * @param siteId     The local site's identity (for tie-breaking).
     * @returns          An LWWUpdate to broadcast to all peers.
     */
    set(field: string, value: T, timestamp: number, siteId: SiteId): LWWUpdate<T> {
        const existing = this.entries.get(field);
        const shouldWrite = !existing
            || timestamp > existing.timestamp
            || (timestamp === existing.timestamp && siteId > existing.siteId);

        if (shouldWrite) {
            this.entries.set(field, { value, timestamp, siteId });
        }

        return { type: "lww_update", field, value, timestamp, siteId };
    }

    /**
     * Merge a remote state snapshot into the local register.
     *
     * For each field in `remoteState`, applies the LWW rule:
     *   1. Accept if field is absent locally.
     *   2. Accept if remote timestamp is strictly greater.
     *   3. Accept on timestamp tie if remote siteId is lexicographically greater.
     *
     * @returns  LWWUpdate entries for every field that actually changed locally,
     *           so the caller can notify the UI/editor of the new values.
     */
    merge(remoteState: LWWState<T>): LWWUpdate<T>[] {
        const changedUpdates: LWWUpdate<T>[] = [];

        for (const [field, remoteEntry] of Object.entries(remoteState)) {
            const localEntry = this.entries.get(field);

            const isNew = !localEntry;
            const isNewer = localEntry && remoteEntry.timestamp > localEntry.timestamp;
            const isTieBreakWinner = localEntry &&
                remoteEntry.timestamp === localEntry.timestamp &&
                remoteEntry.siteId > localEntry.siteId;

            if (isNew || isNewer || isTieBreakWinner) {
                this.entries.set(field, remoteEntry);
                changedUpdates.push({
                    type: "lww_update",
                    field,
                    value: remoteEntry.value,
                    timestamp: remoteEntry.timestamp,
                    siteId: remoteEntry.siteId,
                });
            }
        }

        return changedUpdates;
    }

    /** Returns the names of all fields currently stored in the register. */
    fields(): string[] {
        return Array.from(this.entries.keys());
    }

    /**
     * Produce a full state snapshot suitable for broadcasting as a MetaMessage
     * or for initialising a new peer's register.
     */
    snapshot(): LWWState<T> {
        const state: LWWState<T> = {};
        for (const [field, entry] of this.entries.entries()) {
            state[field] = { ...entry };
        }
        return state;
    }
}
