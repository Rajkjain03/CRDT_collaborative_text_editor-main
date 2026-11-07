# Phase 4 — Test Plan

## Scope and goals

Phase 4 is not about adding features. It is about producing the evidence that the prototype works under stress, characterizing its performance, and validating the claims that will appear in the report. This document is the test plan that drives that evidence collection.

By the end of Phase 4 every test described here must either pass cleanly or have a documented expected behavior (some scenarios are designed to surface known limitations rather than pass — those are explicitly called out).

The tests fall into three layers:

- **Automated unit and integration tests** — extend the existing test suites in `crdt-engine/`, `collab-sync/`, and `collab-editor/`. Run via `npm test`. Failures block the release.
- **Automated stress and benchmark tests** — new suite in `tests/integration-stress/` and `benchmarks/`. Run via dedicated scripts. Produce numerical results that go into the report.
- **Manual end-to-end scenarios** — exercised by humans through the running prototype, checking visual and behavioral correctness that automation cannot verify (cursor rendering, perceived latency, demo flow). Documented as a checklist that the team runs through together.

---

## Layer 1 — Automated tests (already exist + extensions)

These tests are inherited from earlier phases. Phase 4's job is to keep them all green and add a few new cases that surface from cross-phase integration.

### Existing test suites — must remain green

| Package | Suite | Count (expected) | What it covers |
|---|---|---|---|
| `crdt-engine` | `RGADocument.test.ts` | ~25 | Single-replica linked list operations, conflict resolution |
| `crdt-engine` | `TombstoneGC.test.ts` | ~14 | GC pruning logic |
| `crdt-engine` | `convergence.test.ts` | ~12 | Multi-replica property tests |
| `crdt-engine` | `LWWRegister.test.ts` | ~22 | LWW merge and idempotency |
| `crdt-engine` | `Replica.test.ts` | ~24 | Composed clock + RGA + GC + LWW behavior |
| `crdt-engine` | `NetworkSim.test.ts` | ~34 | In-memory network with two-way partition |
| `collab-sync` | `roles.test.ts` | varies | Token mint/validate, permission checks |
| `collab-sync` | `sessionManager.test.ts` | varies | Session lifecycle |
| `collab-sync` | `relay.test.ts` | varies | Relay forwarding, role rejection, log replay |
| `collab-sync` | `ConnectionManager.test.ts` | 17 | WebSocket state machine, backoff |
| `collab-sync` | `OfflineQueue.test.ts` | 18 | IDB queue persistence and ordering |
| `collab-sync` | `ClientSync.test.ts` | 16 | Client orchestration with mock socket |
| `collab-sync` | `integration.test.ts` | 4+ | Real relay + real WebSocket end-to-end |
| `collab-editor` | `bridge/CollabBridge.test.ts` | new | CM6 ↔ CRDT translation |
| `collab-editor` | `bridge/offsetMap.test.ts` | new | NodeId ↔ visible offset under concurrent edits |
| `collab-editor` | `extensions/remoteCursors.test.ts` | new | Cursor rendering |
| `collab-editor` | `undo/HistoryStack.test.ts` | new | Undo stack invariants |

Run all at once:

```bash
cd crdt-engine    && npm test
cd ../collab-sync && npm test
cd ../collab-editor && npm test
```

### New cross-phase regression tests to add

These probe interactions that no single phase's tests cover.

**`tests/integration-stress/replay-with-causal-buffer.test.ts`** — When the relay replays missed ops to a rejoiner, those ops may arrive out of dependency order if the log ordering doesn't match causal order across senders. Verify that `CausalBuffer` correctly buffers and applies them. Setup: 3 clients A/B/C, A and B exchange ops, C disconnects, A and B continue, C reconnects. Assert C converges with A and B.

**`tests/integration-stress/log-overflow.test.ts`** — Set `MAX_LOG_SIZE` to a small value (10) via test injection, generate 30 ops, have a fresh client join. Assert: client receives the 10 most recent ops; older ones are missing; client's CausalBuffer holds the partial chain (it has not converged but has not crashed either). Documents the known limitation that long-offline clients beyond log retention may not converge.

**`tests/integration-stress/role-change-while-typing.test.ts`** — Owner changes Bob from Editor to Viewer while Bob is mid-edit. Bob's in-flight ops should be processed (relay grants the role at message receipt time, not generation time). Subsequent ops from Bob should be rejected.

### UI component tests (Phase 3 → Phase 4 hardening)

These are React Testing Library tests for the `collab-editor` UI components. Phase 3 produces the components; Phase 4 ensures they have systematic coverage. Add to `collab-editor/tests/ui/`.

**`ui/PresenceBar.test.tsx`** — renders correct number of avatars for current peers, updates when `onSiteJoined`/`onSiteLeft` fire, assigns deterministic colors per siteId (same site always gets same color across renders), shows "you" indicator on the local site's avatar.

**`ui/RoleManager.test.tsx`** — only visible when `client.getRole() === Owner`, lists current peers with their roles, mint-token form validates input (no empty siteIds, valid role selection), copies generated token to clipboard, displays minted token for at least 30 seconds before clearing, shows error feedback when mint fails.

**`ui/ConnectionStatus.test.tsx`** — renders correct color and label for each of the four connection states (`disconnected`, `connecting`, `connected`, `reconnecting`), updates within 100ms of `onConnectionChange` firing, shows reconnect attempt count when in `reconnecting` state.

**`ui/DocumentTitle.test.tsx`** — two-way binding: typing updates the LWW field, remote updates appear in the field, debounce prevents per-keystroke broadcasts (only one `setMeta` call per 300ms of continuous typing), handles empty title gracefully.

**`ui/App.test.tsx`** — top-level layout renders editor, presence bar, status, and title; viewer role hides the role manager; owner sees role manager; loading state shows while `connect()` is pending; connection failure shows error UI with retry button.

### CodeMirror extension tests

These test the CM6 extensions in isolation, mounted on a headless `EditorView` without a real React tree.

**`extensions/remoteCursors.test.ts`** — given a presence map with 3 peers, verifies 3 caret widgets render at the correct DOM positions; selection ranges render as decorated ranges with correct CSS class; widgets unmount when peers disconnect; widget DOM updates within one tick when peer cursor moves.

**`extensions/readOnly.test.ts`** — when `client.getRole() === Viewer`, `EditorState.readOnly` facet is true; keystrokes do not produce transactions; when role transitions Viewer→Editor, the facet flips and keystrokes start producing transactions.

**`extensions/undoRedo.test.ts`** — Cmd-Z dispatches the inverse of the last local op; remote ops don't enter the local undo stack; redo dispatches the original op; undoing past empty stack is a silent no-op; stack capacity bound is honored (oldest entry dropped after N=100 entries).

---

## Layer 2 — Stress tests and benchmarks

These produce the headline numbers for the report. They run against a real `RelayServer` instance with real `ws` connections — no mocks. They use the same `ClientSync` code paths as the live prototype.

### Convergence stress

**Scenario S1: 10 clients, 10,000 ops total**

Goal: validate the headline correctness claim under concurrent load.

Setup:
- One relay on port 9000.
- 10 `ClientSync` instances, all `Editor` role, all connected.
- Each client randomly inserts a character at a random offset every 10 ms for 10 seconds (≈1000 ops per client, 10,000 total).

Pass criteria:
- All 10 replicas converge to the same string within 5 seconds of the last op.
- No replica's text has fewer characters than the total inserts (no ops dropped).
- No replica throws or disconnects during the run.

Execution:
```bash
cd benchmarks
npm run stress -- --workload concurrentTyping --clients 10 --ops-per-client 1000
```

**Scenario S2: 5 clients, sustained typing for 60 seconds**

Goal: detect memory leaks and tombstone-GC pressure under sustained load.

Setup:
- 5 clients, each inserts at a steady 5 Hz for 60 seconds.
- Periodic deletes (every 10th op is a delete of a random visible character).

Pass criteria:
- All clients converge.
- Total RGA node count after the run is less than 1.5× the visible character count (i.e., GC is keeping up — tombstone retention is bounded).
- Process memory growth over the run is sublinear in op count.

**Scenario S3: 3 clients, 10,000-character starting document, mid-document concurrent edits**

Goal: verify that the offset/NodeId translation in `CollabBridge.offsetMap` stays correct under concurrent edits to a large document.

Setup:
- One client preloads a 10k-character document. Wait for full sync.
- All three clients simultaneously insert characters in the middle (offsets 4000–6000) for 10 seconds.

Pass criteria:
- All clients converge.
- The original 10k characters are all still present in every replica (no "lost" characters from offset miscalculation).

### Partition / heal stress

**Scenario S4: 100 partition/heal cycles**

Goal: validate `OfflineQueue` flush + relay log replay across many cycles.

Setup:
- 2 clients connected.
- Loop 100 times: client A disconnects, types 10 chars, reconnects, waits for convergence with B (who has been editing throughout).

Pass criteria:
- All 100 cycles complete without error.
- Final document matches A's view + B's view exactly.
- Average time-to-converge after reconnect is under 500 ms.

**Scenario S5: Reconnect storm**

Goal: validate the relay's join handshake throughput.

Setup:
- 20 clients all connected, then all disconnect simultaneously, then all reconnect within a 1-second window.

Pass criteria:
- All 20 clients re-establish sessions within 5 seconds.
- Each receives the missed ops via replay and converges with the others.
- No relay crash or memory spike beyond 2× steady-state.

**Scenario S6: Long-offline replay**

Goal: validate the boundary of log-replay correctness.

Setup:
- 2 clients connected. A goes offline.
- B types 500 ops over 60 seconds.
- A reconnects.

Pass criteria:
- A receives all 500 ops via replay (assuming `MAX_LOG_SIZE` >= 500).
- A converges with B.
- Replay completes in under 2 seconds.

### Latency benchmarks

**Scenario S7: Op-to-visible latency, single relay, single LAN**

Goal: characterize end-to-end op delivery latency for the report.

Setup:
- 2 clients on the same machine, relay also local.
- Client A inserts 1,000 characters at 100 ms intervals.
- Each op is timestamped at generation; receiving client logs `now - opTimestamp` when the op is applied.

Pass criteria (for reporting, not blocking):
- p50 latency under 20 ms.
- p99 latency under 100 ms.
- No latency outliers above 1 second.

Output: histogram in `benchmarks/results/latency-local.json`, plotted in the report.

**Scenario S8: Throughput**

Goal: characterize sustainable throughput.

Setup:
- 1 client publishing as fast as it can for 10 seconds.
- 1 receiver client.

Pass criteria (reporting):
- At least 1,000 ops/sec sustained (basic functional throughput).
- No relay backpressure or socket-buffer overflow.

Output: `benchmarks/results/throughput.json`.

### Comparative analysis benchmarks

**Scenario S9: RGA vs LWW for document body (counter-experiment)**

Goal: empirically demonstrate why LWW is wrong for document content.

Setup:
- Two implementations run side-by-side on identical workloads:
  - The real RGA-based document
  - A toy LWW-based document (one LWW field per character index)
- Workload: 3 clients each insert a different character at offset 5 simultaneously.

Pass criteria:
- RGA converges with all 3 characters present.
- LWW converges with only 1 character present (last write wins, 2 characters lost).

Output: `docs/COMPARATIVE_ANALYSIS.md` with the numerical evidence.

**Scenario S10: RGA vs LWW for title field**

Goal: demonstrate why RGA is overkill for metadata.

Setup:
- Same two implementations.
- Workload: change a 50-character title 100 times.

Pass criteria:
- LWW: 100 ops broadcast, ~5 KB total bandwidth.
- RGA: ~5,000 ops broadcast (50 characters × 100 changes), ~250 KB total bandwidth.

Output: bandwidth comparison plot in `COMPARATIVE_ANALYSIS.md`.

### Execution

All Layer 2 scenarios run via:

```bash
cd benchmarks
npm run stress -- --workload <scenario> [options]
```

Each writes raw results to `benchmarks/results/<scenario>.json`. The reporting script `npm run plot` consumes these and emits markdown + figures into `docs/figures/`.

---

## Layer 3 — Manual end-to-end scenarios

These are the human-driven checks. Each is a checklist item the team runs through together before the demo. They cover what automation cannot — visual correctness, perceived responsiveness, demo-day flow.

Run all manual scenarios on **two physical devices on the same LAN** unless otherwise noted. Use three browser windows on those devices to simulate three users.

### Setup for manual tests

```bash
# On host device
cd collab-sync
PORT=8787 npm run server
# Note the owner site ID and token printed at startup
```

```bash
# On host device, terminal 2 — owner
cd collab-editor
npm run dev
# Open browser to http://localhost:5173
# Paste owner site ID and token in the connect form
```

```bash
# In owner UI: use Role Manager to mint editor token for "bob"
# Copy the token; share it via chat to the second device
```

```bash
# On second device
cd collab-editor
npm run dev
# Open browser to http://<HOST_IP>:5173
# Paste site ID "bob" and the editor token
```

### Manual scenario M1 — Basic two-device collaboration

**Steps:**
1. Both clients show "connected" in the status bar.
2. Alice types "Hello world" in her editor.
3. Bob watches Alice's editor and confirms text appears character-by-character on his side.
4. Bob places his cursor at position 5 and types "—from Bob".
5. Alice confirms Bob's text appears at position 5 with no garbled characters.

**Pass:**
- Both editors show identical text within 200ms of last keystroke.
- No flicker, no jumping cursor, no visible "ops in flight" delay beyond network RTT.

**Common failure modes to look for:**
- Text appearing in the wrong order (RGA tie-breaking bug).
- One side's edits "overwriting" the other (concurrency bug).
- Visible lag spikes (more than 500ms between keystroke and remote visibility).

---

### Manual scenario M2 — Cursor presence and selection

**Steps:**
1. Alice and Bob both connected, document has "the quick brown fox".
2. Alice clicks at position 4 (between "the" and "quick").
3. Bob's editor should show Alice's caret at position 4, in Alice's color.
4. Alice selects "quick brown" by dragging.
5. Bob's editor should show Alice's selection highlighted in Alice's color.
6. Alice types " very", causing the document to become "the very quick brown fox".
7. Bob's editor should show Alice's caret moving forward as she types.

**Pass:**
- Caret position matches Alice's actual position within ±1 character.
- Selection rendering follows drag in real-time.
- Bob's caret stays anchored to its character even as Alice inserts text before it.
- Avatars in the presence bar match the colors of the carets.

**Edge case:** Bob deletes the character Alice's cursor is anchored to. Alice's cursor on Bob's view should jump to the adjacent character, not crash or vanish.

---

### Manual scenario M3 — Offline editing with sync-on-reconnect

**Steps:**
1. Both connected. Alice types "online".
2. Bob confirms he sees "online".
3. Alice clicks "Disconnect" (or the host disconnects WiFi briefly).
4. Alice's status pill shows "offline" or "reconnecting".
5. Alice types " edits while offline" — this appears in her editor.
6. Bob does NOT see Alice's offline edits during this period.
7. Bob types " by Bob" — this appears in his editor.
8. Alice does NOT see Bob's edits during this period.
9. Alice clicks "Reconnect" (or the host restores WiFi).
10. Within 2 seconds, both editors converge to identical text containing all the edits from both sides.

**Pass:**
- During the offline period, each client's local edits work normally with no errors.
- After reconnect, neither side loses any characters.
- Convergence happens within a couple of seconds.
- The final string ordering reflects RGA tie-breaking (deterministic, not random).

**This is the headline "sync-on-reconnection" demo.** The relay's op log replay (inbound) and the client's `OfflineQueue` flush (outbound) are both being exercised here. If this works, the proposal commitment is met.

---

### Manual scenario M4 — Late joiner replay

**Steps:**
1. Alice connects alone, types a paragraph (50+ characters).
2. Wait 5 seconds — only Alice is in the session.
3. Bob connects fresh.
4. Bob's editor should populate with Alice's full paragraph within 1 second of connecting.

**Pass:**
- Bob does not start with an empty document.
- The text Bob receives is identical to Alice's.

**Why this matters:** Earlier README drafts had this listed as an expected failure ("late joiners get empty document"). The relay's op log fixes this. Manual confirmation of M4 is the visual proof that fix works.

---

### Manual scenario M5 — Three-way concurrent editing

**Steps:**
1. Three clients (Alice, Bob, Charlie) all connected.
2. Document is empty.
3. On a count of 3, all three users type 10 characters as fast as they can — different content on each (Alice types "AAAAAAAAAA", Bob types "BBBBBBBBBB", Charlie types "CCCCCCCCCC").
4. After 5 seconds of settling, compare all three editors.

**Pass:**
- All three editors show the exact same final string.
- The string contains exactly 30 characters: 10 A's, 10 B's, 10 C's.
- Order of A/B/C runs follows RGA tie-breaking (deterministic).

**Edge case:** Repeat this scenario 5 times and confirm the final ordering is identical every time. Non-determinism here would indicate a CRDT correctness bug.

---

### Manual scenario M6 — Role enforcement (UI level)

**Steps:**
1. Alice (owner) and Bob (editor) connected.
2. From Alice's Role Manager, demote Bob to Viewer.
3. Bob's UI should within 1 second:
   - Show his role as "viewer" in the status bar.
   - Make the editor read-only (visually grayed out, cursor invisible, no keystrokes accepted).
4. Bob attempts to type — keystrokes do nothing visible.
5. Alice continues typing — Bob sees her edits appear (viewers can read).

**Pass:**
- Role transition is reflected in Bob's UI within 1 second.
- The editor stops accepting input cleanly (no error popups, just no-op).
- Bob continues to receive Alice's edits.

**Edge case:** Try with Bob mid-keystroke — what happens to in-flight ops? Expected: any ops Bob already sent before the role change get processed; any after get rejected with an error in the console (non-fatal).

---

### Manual scenario M7 — Token minting from owner UI

**Steps:**
1. Alice (owner) is the only one connected.
2. Alice opens the Role Manager and clicks "Invite editor".
3. UI prompts for a site name (e.g., "diana"). Alice enters it.
4. UI displays a token, with a "Copy to clipboard" button.
5. Alice copies the token, opens a third browser, connects with site ID "diana" and that token.
6. Diana's connection succeeds; her role shows as "editor".
7. Diana types — Alice sees her edits.

**Pass:**
- Token mint UI works without errors.
- Token is valid for the session.
- Diana joins as the role Alice selected.

**Edge case:** Generate a viewer token instead. Confirm Diana cannot type after connecting.

---

### Manual scenario M8 — Local undo / redo

**Steps:**
1. Alice and Bob both connected.
2. Alice types "Hello".
3. Alice presses Cmd-Z (or Ctrl-Z). The "o" should disappear from her editor.
4. Bob's editor should also show the "o" disappearing.
5. Alice presses Cmd-Z four more times. Her editor empties.
6. Bob's editor matches.
7. Alice presses Cmd-Shift-Z (redo) five times. "Hello" is restored.
8. Bob's editor shows the restoration.

**Pass:**
- Undo affects Alice's edits only, never Bob's.
- Each undo reflects on Bob's side within normal sync latency.
- Redo restores correctly.

**Edge case:** Alice types "Hello", Bob types " world" between Alice's keystrokes 3 and 4. Alice undoes 3 times. Bob's "world" must remain intact — only Alice's last 3 characters disappear. This is the "local undo doesn't undo others" guarantee.

**Edge case:** Alice undoes more times than she has edits. The undo should silently no-op once the stack is empty, never throw or undo Bob's edits.

---

### Manual scenario M9 — Real network drop on a real device

**Steps:**
1. Both connected on two devices over WiFi.
2. On Bob's device, turn WiFi off (the radio, not just the app).
3. Bob's status pill should show "reconnecting" within 5 seconds.
4. Bob types "offline-bob" — appears locally.
5. Alice continues typing on her side; her edits should NOT reach Bob.
6. After 30 seconds of offline state, turn WiFi back on.
7. ConnectionManager's exponential-backoff reconnect should succeed within ~30 seconds.
8. After reconnect, both sides converge.

**Pass:**
- Offline state is detected reliably.
- Reconnect succeeds without manual intervention.
- Both sides' edits arrive at the other after reconnect, with no losses.

**This is the most important real-world test.** Run it last in any test session.

---

### Manual scenario M10 — Document title (LWW metadata)

**Steps:**
1. Alice and Bob connected.
2. Alice changes the document title to "Draft One" using the title field.
3. Bob sees title update within 500 ms.
4. Bob simultaneously changes the title to "Final Version".
5. After both changes settle, both sides agree on one of the titles (whichever had the higher LWW timestamp).

**Pass:**
- Title updates are visible to both sides.
- The final title is the same on both sides (LWW convergence).
- Whichever wins, it does so deterministically.

**Edge case:** Disconnect Alice, have her change the title locally, reconnect. The relay's `MetaMessage` rebroadcast on reconnect should propagate her title change.

---

### Manual scenario M12 — Visual layout and responsive behavior

**Steps:**
1. Open the editor in a desktop browser at 1920×1080.
2. Verify all UI elements visible: editor takes most of the viewport, presence bar at top, status pill in corner, role manager (if owner) accessible.
3. Resize the window down to 1024×768. Confirm no element is clipped or overlapping.
4. Resize to 768×600 (tablet portrait). Some elements may stack — confirm none are unreachable.
5. Open dev tools and toggle device emulation for an iPhone-sized viewport. Confirm the editor is at minimum readable, even if the layout is degraded.
6. Test in Chrome, Firefox, and Safari (or whichever browsers are available).

**Pass:**
- Desktop layout works at all common resolutions (1920, 1440, 1280, 1024 width).
- Tablet layout is functional, even if cosmetically different.
- No element overlaps another in any tested viewport.
- Cross-browser: editor renders and accepts input in all three browsers.

**Edge cases to probe:**
- Long document title — does it truncate gracefully or push other elements off screen?
- Many peers (5+) in the presence bar — does it wrap, scroll, or overflow?
- Very long peer names — do they truncate?

---

### Manual scenario M13 — Error states and edge UI cases

**Steps:**
1. **Connection refused** — start the editor without starting the relay. Click connect. UI should show a clear error ("Cannot reach server") with a retry button. No console error spam, no infinite spinner.
2. **Invalid token** — connect with a deliberately malformed token. UI shows "Invalid token" with guidance ("ask the owner for a new invite").
3. **Token expired** — restart the relay, try to connect with a token from the previous session. UI shows "Session expired" with retry option.
4. **Mid-session relay crash** — kill the relay process while connected. UI should:
   - Switch status pill to "reconnecting" within 5 seconds.
   - Continue accepting local edits (these queue in `OfflineQueue`).
   - Not show an error popup blocking the user.
5. **Mid-session relay restart** — restart the relay (with same secret? new secret?). The current behavior on a new secret will show "Invalid token" — confirm the UI handles this with a clear "session ended" state, not a stuck reconnect loop.

**Pass:**
- Every error has a corresponding UI state — never just a console error or stuck spinner.
- Error messages are user-readable, not stack traces.
- Retry buttons work where they appear.

---

### Manual scenario M14 — Accessibility (keyboard and screen reader)

**Steps:**
1. **Keyboard-only navigation** — disconnect the mouse. Navigate the entire UI using Tab, Shift-Tab, Enter, Space, Esc, Arrow keys.
   - Reach every interactive element (buttons, inputs, the editor).
   - Visible focus indicator on every focused element.
   - Forms (token entry, title field) submit on Enter.
   - Esc closes any modal dialogs.
2. **Screen reader smoke test** — turn on the OS screen reader (VoiceOver, NVDA, or Orca).
   - Each button has a descriptive label (not just "button").
   - The editor announces as an editable text region.
   - Status changes (connection state, role change) are announced as live regions.
   - Presence updates ("Bob joined") are announced.
3. **Color contrast** — use a contrast checker on the rendered UI. Text/background pairs should meet WCAG AA (4.5:1 for body text, 3:1 for large text). Cursor colors for peers should also be perceivable to users with common color-vision deficiencies.

**Pass:**
- Every interactive element reachable by keyboard.
- Visible focus ring on the focused element.
- Screen reader announces meaningful labels and state changes.
- Contrast meets AA.

**This is sometimes deferred as "we'll do it later" — for a course project, even a smoke-level pass here is worth doing because graders often check.**

---

### Manual scenario M15 — Cursor presence visual stress test

**Steps:**
1. Five clients connected to the same document.
2. Each user moves their cursor rapidly (rapid arrow key navigation, or click-and-drag selections) for 30 seconds.
3. Watch on each user's screen.

**Pass:**
- Each peer's caret is rendered.
- Carets update smoothly (no flicker, no jumping back and forth).
- Peer colors are stable across the session — Alice doesn't suddenly become "yellow" instead of "red".
- Removing a peer (one disconnects) cleanly removes their caret from everyone else's view.

**Edge case:** Two peers' cursors at the exact same offset — both should render visibly (one slightly offset, or stacked with both colors visible). They should not occlude each other entirely.

---

### Manual scenario M16 — Editor input edge cases

**Steps:**
1. **Paste a paragraph** (500+ characters) into the editor. Verify it appears and propagates to other clients.
2. **Paste over a selection** — select some text, then paste different text. Original is replaced with pasted content. Both ops (delete + insert) propagate correctly.
3. **Composition input (IME)** — if testing on a Mac/Linux with multilingual support, type using a Chinese/Japanese/Korean input method that uses composition (typing latin chars then converting). Verify the editor doesn't fire ops for each pre-composition keystroke; only the final composed character is broadcast.
4. **Emoji and surrogate pairs** — type or paste emoji (🎉, 👋, etc.). Verify they survive RGA insert/delete (treated as multi-codepoint characters, not split mid-pair).
5. **Very rapid typing** — hold down a letter key for 5 seconds. The editor's local view should keep up; remote clients should converge afterward; no ops should be dropped.
6. **Undo right after paste** — paste a paragraph, immediately Cmd-Z. The entire paste should undo as one operation (or as N character-deletes — whichever is consistent).

**Pass:**
- Paste works for arbitrary text (including with newlines).
- IME composition does not produce one op per pre-composition keystroke.
- Emoji are preserved across the network round-trip.
- Rapid typing produces correct ops with no drops.

**Edge cases that often fail:**
- Newlines in pasted content (some implementations strip them).
- Tab characters (verify they're inserted literally, not treated as focus navigation).
- Right-to-left text (Arabic, Hebrew) — does the cursor positioning work correctly?

---

### Manual scenario M17 — Theme and visual consistency

**Steps:**
1. If the editor supports light and dark themes, switch between them. Verify all components (editor, presence bar, role manager, status pill, peer cursors) update correctly.
2. Verify peer cursor colors are visible in both themes (a yellow caret on a white background may be invisible).
3. Check that the editor's font, line-height, and padding match the rest of the app.

**Pass:**
- Theme switch is instant and complete (no half-themed UI).
- Peer cursors remain visible and distinguishable in every theme.
- No "flash of unstyled content" on initial load.

**If you don't have a theme switcher, this is just a one-time visual review — no need to skip it entirely.**

---

### Manual scenario M11 — Demo dry run (full demo script)

**Steps:** Execute `docs/DEMO_SCRIPT.md` end-to-end on the actual demo hardware, including any projector/screen-sharing setup. Time the full demo.

**Pass:**
- Demo runs in under 10 minutes.
- No technical hiccups (lost connections, browser refresh needed, token paste failures).
- Demonstrator can narrate without checking notes.

Run this dry run at least twice before the actual demo. Once on Day 36, once immediately before the demo on Day 37.

---

## Test execution timeline

This is the order tests must be run in over Phase 4 days 29–37.

| Day | Tests run |
|---|---|
| 29 | Layer 1 — re-confirm all existing test suites are still green; add UI component tests if Phase 3 didn't include them |
| 30 | Layer 2 — S1, S2 (convergence stress) |
| 31 | Layer 2 — S3 (large doc), S7 (latency) |
| 32 | Layer 2 — S4, S5 (partition/heal) |
| 33 | Layer 2 — S6 (long-offline), S8 (throughput) |
| 34 | Layer 2 — S9, S10 (comparative analysis) |
| 35 | Layer 3 — M1, M2, M3, M4, M5 (collaboration basics + offline); M12, M16 (UI layout + input edge cases) |
| 36 | Layer 3 — M6, M7, M8, M10 (roles + undo + title); M13, M14, M15, M17 (UI errors + a11y + cursor stress + theme); M11 dry run |
| 37 | Layer 3 — M9 (real network drop) + M11 final dry run + live demo |

If any test in Layer 1 or 2 fails on its scheduled day, fix it before moving on. If a manual test in Layer 3 surfaces a bug, decide whether to fix or document as a known limitation depending on severity and remaining time.

---

## Test data and acceptance criteria summary

| Layer | Test count | Pass requirement |
|---|---|---|
| Layer 1 — automated unit & integration | ~200+ existing + ~10 new + ~15 UI component tests | 100% pass — failures block release |
| Layer 2 — stress & benchmarks | 10 scenarios (S1–S10) | All pass; numerical results documented in report |
| Layer 3 — manual | 17 scenarios (M1–M17) | All pass; M11 rehearsed at least twice |

Total test budget: 9 days, ~6 hours per day. Allocate 60% of time to Layer 2 (these produce report figures and take time to run + analyze), 30% to Layer 3 (cross-device coordination is slow), 10% to Layer 1 maintenance.

---

## Known limitations to document, not fix

These are scenarios that will fail or behave imperfectly. They are **not bugs to fix in Phase 4** — they are scope boundaries from earlier phase decisions. Document them in the report under "Limitations":

1. **Log retention bound** — clients offline for longer than `MAX_LOG_SIZE` worth of activity (10,000 ops) will not converge on reconnect without manual intervention. Phase 5 (out of scope) would add periodic state snapshots.

2. **Collaborative undo** — Alice's Cmd-Z affects only Alice's edits, never Bob's. True collaborative undo (where the system tracks causal effects across users) is a research problem and was explicitly de-scoped in the proposal.

3. **TLS not configured** — the relay uses plain `ws://`. Fine for trusted LAN. For internet deployment, terminate TLS at a reverse proxy.

4. **Manual IP discovery** — clients need to be told the relay's IP. mDNS auto-discovery was deferred.

5. **Browser IndexedDB only** — the CLI uses `node-indexeddb` for offline persistence. The browser uses native IndexedDB. Some browsers (Safari private mode) limit IDB; the prototype is not tested on those.

The report's "Limitations" section should list these and explain how each could be addressed in future work, with a one-paragraph sketch per limitation.

---

## Packaging and release

After all tests pass, the prototype must be packaged as a self-contained release that a grader, instructor, or any new user can install and run without prior context. This section is the playbook for that.

The release has two distinct deliverables:

1. **Source release** — a tagged git repository state plus a tarball of the three packages, suitable for a grader who wants to inspect the code or build from scratch.
2. **Runnable release** — pre-built binaries/bundles plus an end-user setup guide, suitable for someone who just wants to run the editor.

### Pre-release checklist

Before tagging the release, run this checklist on a clean machine (or a fresh git clone) to confirm nothing depends on local developer state:

| Item | How to verify |
|---|---|
| All Layer 1 tests pass | `npm test` in each package, expect 100% pass |
| All Layer 2 stress scenarios pass | `cd benchmarks && npm run stress -- --all` |
| Phase 3 demo builds and runs | `cd collab-editor && npm run build && npm run preview` |
| README files are accurate | each of `crdt-engine/README.md`, `collab-sync/README.md`, `collab-editor/README.md` describes how to run that package standalone |
| No `console.log` debug output left in production code paths | grep the source for `console.log` and remove or gate behind a debug flag |
| No `TODO` or `FIXME` comments referring to functional gaps | `grep -r "TODO\|FIXME" --include="*.ts" src/` should return zero functional issues (style/refactor TODOs are fine) |
| Dependencies pinned | `package-lock.json` files committed in every package |
| Token secrets aren't committed | `git log --all -p` should show no instance of a literal session secret |
| Node version specified | `.nvmrc` or `engines` field in each `package.json` declaring the Node version |
| License file at repo root | `LICENSE` (MIT or whatever the team chose) |

Run this checklist on Day 36, in the morning. Anything failing here gets fixed before the demo.

### Source release — tag and bundle

**Step 1 — Freeze the version.**

In each package's `package.json`, bump version to `1.0.0`:

```bash
cd crdt-engine    && npm version 1.0.0 --no-git-tag-version
cd ../collab-sync && npm version 1.0.0 --no-git-tag-version
cd ../collab-editor && npm version 1.0.0 --no-git-tag-version
cd ..
```

**Step 2 — Commit and tag.**

```bash
git add -A
git commit -m "Release 1.0.0"
git tag -a v1.0.0 -m "CRDT collaborative editor — final prototype"
git push origin main --tags
```

**Step 3 — Create source tarball.**

```bash
git archive --format=tar.gz --prefix=crdt-collab-editor-1.0.0/ \
  -o crdt-collab-editor-1.0.0-src.tar.gz v1.0.0
```

The tarball excludes `node_modules`, build outputs, and IDE metadata via `.gitattributes`. Add this file at the repo root if it doesn't exist:

```
node_modules export-ignore
dist        export-ignore
coverage    export-ignore
.indexeddb  export-ignore
.idea       export-ignore
.vscode     export-ignore
*.log       export-ignore
```

**Step 4 — Verify the tarball.**

On a clean machine (or a temp directory), extract and build:

```bash
tar xzf crdt-collab-editor-1.0.0-src.tar.gz
cd crdt-collab-editor-1.0.0
cd crdt-engine && npm install && npm test
cd ../collab-sync && npm install && npm test
cd ../collab-editor && npm install && npm test
cd ../collab-editor && npm run build
```

Every step must succeed without manual intervention. If `npm install` produces warnings about peer dependencies or deprecated packages, document them in the release notes — don't try to fix them at this stage unless they cause functional failure.

### Runnable release — build artifacts

**The browser bundle (`collab-editor`):**

```bash
cd collab-editor
npm run build
# produces dist/ — static HTML, JS, CSS
```

The contents of `dist/` can be served by any static file server. They include the CodeMirror editor, React UI, and the compiled `ClientSync` code that runs in the browser.

**The relay server (`collab-sync/server`):**

Two options:

*Option A — ship as Node source.* The user needs Node 20+ installed. They run:

```bash
cd collab-sync
npm install --production
PORT=8787 npm run server
```

This is the simpler option and matches how the prototype runs during development.

*Option B — bundle into a single executable.* Use `pkg` or `bun build --compile` to produce a standalone binary. This adds complexity but lets a non-developer run the relay without installing Node:

```bash
cd collab-sync
npm install --save-dev pkg
npx tsc                              # compile TypeScript to JS
npx pkg dist/server/server.js \
  --targets node20-linux-x64,node20-macos-x64,node20-win-x64 \
  --output dist/relay
```

Recommendation: **Option A for the course release.** Option B is real-world deployment territory and adds 30–60 minutes of fiddling for marginal demo benefit.

**Combined release tarball:**

```bash
mkdir -p release/crdt-collab-editor-1.0.0
cp -r collab-sync release/crdt-collab-editor-1.0.0/relay-server
cp -r collab-editor/dist release/crdt-collab-editor-1.0.0/editor-static
cp docs/USER_GUIDE.md release/crdt-collab-editor-1.0.0/
cp LICENSE release/crdt-collab-editor-1.0.0/
cp README.md release/crdt-collab-editor-1.0.0/

cd release
tar czf crdt-collab-editor-1.0.0-runnable.tar.gz crdt-collab-editor-1.0.0/
```

The runnable tarball contains: a `relay-server/` directory with the Node-source relay, an `editor-static/` directory with the built browser bundle, a user guide, a LICENSE, and a top-level README pointing at the user guide.

### End-user setup guide

This is a fresh document — `docs/USER_GUIDE.md` — written for someone who has the runnable tarball and no other context. It is *not* the same as the per-package READMEs (those are for developers). Structure:

```markdown
# CRDT Collaborative Editor — User Guide

## What you have
A real-time collaborative text editor that runs on your local network.
One person hosts (runs the relay server), others connect from a browser.

## What you need
- One computer to act as the host (runs Node 20+)
- Other computers to act as clients (any modern browser)
- All computers on the same WiFi or LAN

## Step 1 — On the host computer
1. Install Node 20+ from nodejs.org if you don't have it.
2. Open the `relay-server/` folder in a terminal.
3. Run: `npm install`
4. Run: `PORT=8787 npm run server`
5. The terminal will print an "Owner Token" — copy it. You'll need it.
6. The terminal will also print your computer's LAN address — copy that too.

## Step 2 — Serve the editor (still on the host)
1. Open a second terminal.
2. Go into the `editor-static/` folder.
3. Run: `npx serve -l 5173`
   (This serves the built editor on port 5173.)

## Step 3 — On any computer (including the host)
1. Open a web browser.
2. Visit `http://<HOST_IP>:5173` (use the LAN address from Step 1).
3. Paste the Owner Token from Step 1.
4. You're now the document owner.

## Step 4 — Invite others
1. In the editor, open the Role Manager panel.
2. Click "Invite Editor" and enter a name (e.g., "alice").
3. Click "Copy Token" and share that token with the person joining.
4. They visit `http://<HOST_IP>:5173`, paste the token and the name, click connect.

## Step 5 — Edit together
Type. Their cursor and edits appear in real time.

## Troubleshooting
- "Cannot reach server" — check the IP address; check WiFi.
- "Invalid token" — ask the host for a new invite (tokens are tied to the
  current relay run; restarting the relay invalidates old tokens).
- Editor won't load — try a different browser; Chrome/Firefox/Safari are tested.

## What works
- Real-time editing across multiple devices
- Continue editing while disconnected; changes sync when you reconnect
- Owner can set Editor or Viewer roles
- Document title is shared and updates live

## What doesn't (yet)
- Editing while offline for hours then reconnecting may lose some history
  (relay only retains the last 10,000 changes)
- "Undo" only undoes your own edits, not others'
- No internet-grade security; intended for trusted local networks
```

### Optional — Docker image for the relay

If a grader wants to run the relay without a Node install, a small Dockerfile makes it possible:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY collab-sync/package*.json ./
RUN npm install --production
COPY collab-sync/ ./
COPY crdt-engine/ ../crdt-engine/
EXPOSE 8787
CMD ["npm", "run", "server"]
```

Build and run:

```bash
docker build -t crdt-relay:1.0.0 .
docker run -p 8787:8787 -e PORT=8787 crdt-relay:1.0.0
```

This is a nice-to-have, not required. Add it on Day 36 only if Layer 1–3 tests are all green and there's spare time.

### Submission package

For the course submission, prepare:

| File | Contents |
|---|---|
| `crdt-collab-editor-1.0.0-src.tar.gz` | Source tarball from `git archive` |
| `crdt-collab-editor-1.0.0-runnable.tar.gz` | Runnable tarball with relay + editor + user guide |
| `docs/REPORT.pdf` | Compiled course report |
| `docs/COMPARATIVE_ANALYSIS.pdf` | RGA vs LWW empirical analysis |
| `presentation/slides.pdf` | Demo-day slides |
| `presentation/demo-recording.mp4` | Backup recording |
| `README.md` (top-level) | Index pointing at all of the above |

Top-level `README.md` template:

```markdown
# CRDT Collaborative Editor

A real-time collaborative text editor built from scratch using CRDT primitives.
Course project for Distributed Systems, [University], Spring 2026.

## Team
- Yashwant BK
- Rishabh Sahu
- Hussain Lohawala

## Quick start (for graders)
- Want to read the report? → `docs/REPORT.pdf`
- Want to run the prototype? → `docs/USER_GUIDE.md`
- Want to inspect the code? → `crdt-engine/README.md`, `collab-sync/README.md`, `collab-editor/README.md`
- Want to see it work? → `presentation/demo-recording.mp4`

## What's in this package
- `crdt-engine/` — Phase 1: CRDT data structures and simulator
- `collab-sync/` — Phase 2: WebSocket relay and client networking
- `collab-editor/` — Phase 3: CodeMirror UI and React components
- `benchmarks/` — Phase 4: stress tests and benchmark results
- `docs/` — Report, comparative analysis, user guide
- `presentation/` — Demo slides and recording

## Algorithms used
- RGA (Replicated Growable Array) for document body
- LWW-Register for metadata (title, presence, roles)
- Vector clocks + causal-delivery hold-back queue
- Tombstone GC

References for each are in `crdt-engine/README.md`.

## License
MIT — see `LICENSE`.
```

### Day-37 release sequence

The day of the demo:

1. **Morning (08:00–10:00)** — final pre-release checklist on a clean machine. If anything fails, fix it. If a fix can't be made in 30 minutes, document it as a known limitation in `USER_GUIDE.md` and move on.
2. **Mid-morning (10:00–11:00)** — produce both tarballs (`-src` and `-runnable`). Verify each by extracting on a fresh directory and running through the user guide steps end-to-end.
3. **Late morning (11:00–12:00)** — final demo dry-run with the actual tarball, on the actual demo hardware.
4. **Afternoon** — submit the package to the course system, present the demo.

The key principle: by the time you submit, you should have personally watched a clean machine extract your tarball and produce a working editor session, with no shortcuts taken from your dev environment. Anything you can do on your laptop but not on a clean machine will be the thing that breaks during the grader's evaluation.

### Post-release: handing off to future work

If the project continues past the course (some teams open-source theirs or extend in a follow-up class), include a `CONTRIBUTING.md` describing:

- The phased structure and which package owns which concern
- The clock-sequencing invariant (Phase 1's most-easily-broken correctness property)
- The wire protocol stability guarantee (Phase 2 frozen API)
- How to run the test layers locally
- Known limitations and the suggested approach for each

This is optional for the course but takes 30 minutes to write and dramatically lowers the bar for anyone who wants to extend the work.
