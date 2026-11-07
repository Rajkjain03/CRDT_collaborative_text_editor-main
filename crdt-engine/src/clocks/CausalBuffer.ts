/**
 * CausalBuffer — holds incoming ops until their causal dependencies are met.
 *
 * An op's dependencies are satisfied when the local vector clock has already
 * delivered every op that causally precedes it. Each op carries a clock
 * snapshot taken BEFORE the sender incremented their own counter, so the
 * check is: for every site S, localClock[S] >= op.clock[S].
 *
 * When an op's dependencies are met (drain passes hasDelivered), the buffer
 * releases it and advances the local clock by one for the sender:
 *   newClock[sender] = op.clock[sender] + 1
 *
 * Why op.clock[sender] + 1 and not nodeId.counter or targetId.counter?
 * RGADocument maintains a per-document localCounter that is insert-only and
 * diverges from the VectorClock as soon as any delete op occurs. Using
 * nodeId.counter or targetId.counter as a clock advance would under-count
 * after deletes and cause causal delivery to stall for subsequent ops.
 *
 * senderSiteId for delete ops:
 * RGADelete carries only targetId (the deleted node's identity), not the
 * deleting site's identity. Callers that know the sender must pass it
 * explicitly via senderSiteId so the clock can be advanced correctly.
 * Without it, the buffer falls back to targetId (wrong for cross-site
 * deletes) to preserve backwards compatibility with simulator-only paths.
 */

import { SiteId, RGAOperation } from '../types';
import { VectorClock } from './VectorClock';

/**
 * An op held in the buffer waiting for its causal dependencies to be met.
 * `senderSiteId` is required for delete ops to advance the clock correctly;
 * it is optional to preserve backward compatibility with simulator paths
 * that do not supply the sender identity.
 */
export type BufferedOp = {
    op: RGAOperation;
    receivedAt: number; // Unix ms — for diagnostics only, not used for ordering
    senderSiteId?: SiteId;
};

export class CausalBuffer {
    private buffer: BufferedOp[];
    private clock: VectorClock;

    constructor(clock: VectorClock) {
        this.buffer = [];
        this.clock = clock;
    }

    /**
     * Enqueue an incoming op. The op will not be applied until drain() confirms
     * its causal dependencies are satisfied.
     *
     * @param op            The incoming RGA operation.
     * @param senderSiteId  Identity of the site that generated this op.
     *                      Required for delete ops so the clock can be advanced
     *                      by the correct sender counter. For insert ops it is
     *                      derived automatically from op.nodeId.siteId.
     */
    receive(op: RGAOperation, senderSiteId?: SiteId): void {
        this.buffer.push({
            op,
            receivedAt: Date.now(),
            ...(senderSiteId !== undefined ? { senderSiteId } : {}),
        });
    }

    /**
     * Release all buffered ops whose causal dependencies are now satisfied,
     * advancing the local vector clock for each one.
     *
     * Iterates to a fixed point: delivering one op may unblock another, so
     * the loop continues until a full pass produces no new deliveries.
     *
     * Clock advance rules (op.clock is the snapshot taken BEFORE increment):
     *   insert → advance clock[op.nodeId.siteId] to op.clock[siteId] + 1
     *   delete with senderSiteId → advance clock[senderSiteId] to op.clock[senderSiteId] + 1
     *   delete without senderSiteId → fallback: use targetId (simulator-only, may be inaccurate)
     *
     * @returns Ops in the order they were released (causal order).
     */
    drain(): RGAOperation[] {
        const readyOps: RGAOperation[] = [];
        let madeProgress = true;

        while(madeProgress) {
            madeProgress = false;
            const stillPending: BufferedOp[] = [];

            for (const buffered of this.buffer) {
                if (this.clock.hasDelivered(buffered.op.clock)) {
                    readyOps.push(buffered.op);
                    madeProgress = true;

                    // Advance the clock to reflect that this op has been applied.
                    // op.clock is captured BEFORE the sender incremented their counter,
                    // so the sender's post-op counter is op.clock[sender] + 1.
                    // nodeId.counter and targetId.counter are NOT reliable here:
                    // nodeId.counter is a per-document insert-only counter that
                    // diverges from the VectorClock once any delete ops have occurred.
                    if (buffered.op.type === "insert") {
                        const siteId = buffered.op.nodeId.siteId;
                        const senderPre = buffered.op.clock[siteId] ?? 0;
                        this.clock.update({ [siteId]: senderPre + 1 });
                    } else if (buffered.senderSiteId !== undefined) {
                        const senderPre = buffered.op.clock[buffered.senderSiteId] ?? 0;
                        this.clock.update({ [buffered.senderSiteId]: senderPre + 1 });
                    } else {
                        // Fallback when sender is unknown (simulator paths that don't pass senderSiteId).
                        // Uses targetId which is wrong for cross-site deletes but preserves the
                        // old behaviour for same-site-only simulator tests.
                        this.clock.update({ [buffered.op.targetId.siteId]: buffered.op.targetId.counter });
                    }
                } else {
                    stillPending.push(buffered);
                }
            }

            this.buffer = stillPending;
        }

        return readyOps;
    }

    /** Number of ops still waiting for their causal dependencies. */
    pendingCount(): number {
        return this.buffer.length;
    }
}