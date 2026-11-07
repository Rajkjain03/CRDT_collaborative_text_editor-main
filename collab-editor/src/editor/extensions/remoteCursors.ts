import { StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { SelectionPresence } from "../../bridge/presence";
import { OffsetMap } from "../../bridge/offsetMap";
import { SiteId } from "crdt-engine";

export const updatePresenceEffect = StateEffect.define<{
  presences: Map<SiteId, SelectionPresence>;
  offsetMap: OffsetMap;
}>();

class CaretWidget extends WidgetType {
  constructor(readonly color: string) {
    super();
  }

  eq(other: CaretWidget) {
    return other.color === this.color;
  }

  toDOM() {
    const span = document.createElement("span");
    span.style.borderLeft = `2px solid ${this.color}`;
    span.style.marginLeft = "-1px";
    span.style.marginRight = "-1px";
    span.style.position = "relative";
    return span;
  }
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
  return "#" + "00000".substring(0, 6 - c.length) + c;
}

export const remoteCursorsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    // Drop all old presence markers when an update comes in
    // This is naive, ideally we map them using tr.changes
    // For Phase 3, we expect React to push a new StateEffect when presence changes
    
    // In Phase 3 presence design, remote cursors are decoupled from CM6 state changes.
    let newDecos = decorations.map(tr.changes);

    for (const e of tr.effects) {
      if (e.is(updatePresenceEffect)) {
        const { presences, offsetMap } = e.value;
        const builder = [];

        for (const [siteId, presence] of presences.entries()) {
          const color = stringToColor(siteId);
          
          let headOffset = offsetMap.getVisibleOffsetForNodeId(presence.head.nodeId);
          if (headOffset !== null) {
            // Adjust offset if offsetWithinNode is 1 (after node)
            if (presence.head.offsetWithinNode === 1) headOffset++;
            
            builder.push(
              Decoration.widget({
                widget: new CaretWidget(color),
                side: 0
              }).range(headOffset)
            );
          }
        }
        
        // Sort and build
        newDecos = Decoration.set(builder.sort((a, b) => a.from - b.from));
      }
    }
    
    return newDecos;
  },
  provide: f => EditorView.decorations.from(f)
});
