/**
 * crdt-engine/src/clocks/VectorClock.ts — Mutable vector clock.
 *
 * A vector clock is a map from SiteId to a monotonically increasing counter
 * representing the number of operations delivered from that site. It is the
 * causal ordering primitive used by CausalBuffer to decide when an incoming
 * op's dependencies have been met.
 *
 * Counter semantics:
 *   clock[S] = N  means this replica has delivered N operations from site S.
 *
 * This class is mutable and shared by reference with CausalBuffer, which
 * advances it as ops are released. Replica owns a single VectorClock instance
 * and never resets it for the lifetime of the session.
 */

import { SiteId, VectorClockSnapshot } from '../types';

export class VectorClock {
    private clock: Map<SiteId, number>;

    /**
     * @param initialClock  Optional starting state (e.g. when restoring from
     *                      a persisted snapshot). Missing sites default to 0.
     */
    constructor(initialClock?: VectorClockSnapshot) {
        this.clock = new Map();
        if (initialClock) {
            for (const [siteId, counter] of Object.entries(initialClock)) {
                this.clock.set(siteId, counter);
            }
        }
    }

    /**
     * Increment the counter for the given site by 1.
     * Called by Replica after generating a local operation.
     */
    increment(siteId: SiteId): void {
        const current = this.clock.get(siteId) || 0;
        this.clock.set(siteId, current + 1);
    }

    /**
     * Merge a remote snapshot into this clock by taking the component-wise
     * maximum. Called by CausalBuffer after delivering each op to advance
     * the local clock to reflect what has been seen.
     */
    update(remote: VectorClockSnapshot): void {
        for (const [siteId, remoteCounter] of Object.entries(remote)) {
            const localCounter = this.clock.get(siteId) || 0;
            this.clock.set(siteId, Math.max(localCounter, remoteCounter));
        }
    }

    /**
     * Return an immutable snapshot of the current clock state.
     * Used to attach a clock to outgoing ops and to send in JoinMessage.
     */
    snapshot(): VectorClockSnapshot {
        const snap: VectorClockSnapshot = {};
        for (const [siteId, counter] of this.clock.entries()) {
            snap[siteId] = counter;
        }
        return snap;
    }

    /**
     * Returns true if this clock happened-before `other`.
     * A < B iff A[s] <= B[s] for all sites s, with strict inequality for at least one.
     */
    happensBefore(other: VectorClockSnapshot): boolean {
        let hasStrictlyLess = false;
        const allSites = new Set([...this.clock.keys(), ...Object.keys(other)]);

        for (const siteId of allSites) {
            const local = this.clock.get(siteId) || 0;
            const remote = other[siteId] || 0;

            if (local > remote) return false;
            if (local < remote) hasStrictlyLess = true;
        }

        return hasStrictlyLess;
    }

    /**
     * Returns true if this clock and `other` are concurrent — neither
     * happened-before the other. Both must be strictly ahead for at least one site.
     */
    isConcurrent(other: VectorClockSnapshot): boolean {
        let localIsAhead = false;
        let remoteIsAhead = false;
        const allSites = new Set([...this.clock.keys(), ...Object.keys(other)]);

        for (const siteId of allSites) {
            const local = this.clock.get(siteId) || 0;
            const remote = other[siteId] || 0;

            if (local > remote) localIsAhead = true;
            if (local < remote) remoteIsAhead = true;
        }

        return localIsAhead && remoteIsAhead;
    }

    /**
     * Returns true if this clock has delivered all operations captured in `dep`.
     * Concretely: for every site S in `dep`, localClock[S] >= dep[S].
     *
     * CausalBuffer calls this to decide whether an op's causal dependencies
     * have been met before releasing the op for application.
     */
    hasDelivered(dep: VectorClockSnapshot): boolean {
        for (const [siteId, depCounter] of Object.entries(dep)) {
            const localCounter = this.clock.get(siteId) || 0;
            if (localCounter < depCounter) return false;
        }
        return true;
    }
}
