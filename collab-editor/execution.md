
***

# Testing the Collaborative Editor (Phase 3)

This document outlines how to manually test the end-to-end integration of the CRDT engine, the WebSocket relay server, and the React/CodeMirror front-end.

## 1. Start the Relay Server

The relay server routes operations between clients and maintains the authoritative session state.

1. Open a terminal and cd to CRDT_collaborative_text_editor/collab-sync
2. Run the server:
   ```bash
   npx ts-node src/server/server.ts
   ```
3. Wait for the server to bind to the port. You will see an output box like this:
   ```text
   ─────────────────────────────────────────
     collab-sync relay listening on port 8080
   ─────────────────────────────────────────
     Owner Site ID : <random-uuid>
     Owner Token   : <base64-encoded-token>
   ─────────────────────────────────────────
   ```
   **Keep this terminal open and copy the Owner Site ID and Token.**

## 2. Start the Client Application

1. Open a **second terminal** in your `collab-editor` directory.
2. Start the Vite development server:
   ```bash
   npm run dev -- --host
   ```
3. The app will be available at `http://localhost:3000`.

## 3. Connect User 1 (The Owner)

1. Open your browser and navigate to `http://localhost:3000`.
2. In the login screen:
   * **Site ID:** Paste the `Owner Site ID` from the server terminal.
   * **Token:** Paste the `Owner Token` from the server terminal.
3. Click **Connect**.
4. You should see the editor UI load, and the right sidebar should show **Current role: owner**.

## 4. Connect User 2 (The Editor)

Because the relay enforces strict HMAC-SHA256 token validation, you cannot use dummy tokens. The Owner must invite new peers.

1. In the **Owner's** browser window, look at the **Role Management** panel on the right.
2. Type a new Site ID for the peer (e.g., `editor_site`).
3. Click **Create Editor Token**.
4. A green box will appear with the new token. **Copy this token.**
5. Open an **Incognito / Private Browsing window** (or a different browser like Firefox) to ensure separate sessions.
6. Navigate to `http://localhost:3000`.
7. In the login screen:
   * **Site ID:** Enter `editor_site` (or whatever ID you chose in step 2).
   * **Token:** Paste the newly generated token.
8. Click **Connect**. 

## 5. Feature Validation Checklist

Position the two browser windows side-by-side to verify the following CRDT and UI integrations:

### ✅ Real-Time CRDT Text Sync
* Type a paragraph in the Owner window. It should appear instantly in the Editor window.
* Highlight a word in the Editor window and replace it. The change should mirror back to the Owner.
* **Stress Test:** Mash the keyboard in both windows simultaneously. The CRDT engine ensures both windows eventually converge to the exact same text without crashing or losing data.

### ✅ Peer Presence (Remote Cursors)
* Click randomly in the middle of a sentence in the Editor window. 
* A colored vertical caret should appear in the Owner window at that exact location.
* Highlight a sentence in one window; the other window should show a colored background over that selection.

### ✅ LWW Metadata Sync (Document Title)
* Click the "Untitled Document" header in the top-left of either window.
* Rename it to `Project Alpha`.
* The title should instantly update in the other window.

### ✅ Offline Resilience (IndexedDB Queue)
1. Go to the terminal running the **Relay Server** and kill it (`Ctrl+C`).
2. Both browser windows should show the status change to a yellow/red **Reconnecting...** state.
3. Type a new sentence in the Owner window while offline.
4. Restart the Relay Server (`npx ts-node src/server/server.ts`).
5. The UI will automatically reconnect, flush the IndexedDB offline queue, and the Editor window will magically receive the sentence you typed while offline!