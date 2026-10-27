import { useDoc } from '../store/docStore'

export type NodeCommand = 'child' | 'sibling' | 'outdent'

export function nodeCommandForKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean }, editing = false): NodeCommand | null {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null
  if (event.key === 'Tab') return event.shiftKey ? 'outdent' : 'child'
  if (event.key === 'Enter' && !editing && !event.shiftKey) return 'sibling'
  return null
}

/** Both editors use the same structural commands and root/boundary semantics. */
export function executeNodeCommand(command: NodeCommand, id: string, source: 'canvas' | 'outline' = 'canvas'): void {
  const s = useDoc.getState()
  const node = s.doc.nodes[id]
  if (!node) return
  if (command === 'child') s.addChild(id, source)
  else if (command === 'sibling') {
    if (id === s.doc.rootId) s.addChild(id, source)
    else s.addSibling(id, source)
  } else {
    const parent = node.parent && s.doc.nodes[node.parent]
    if (!parent || !parent.parent) return
    const grandparent = s.doc.nodes[parent.parent]
    if (!grandparent) return
    s.reparentAt(id, grandparent.id, grandparent.children.indexOf(parent.id) + 1)
    s.select([id])
    if (source === 'canvas') requestAnimationFrame(() => document.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus())
    else s.setEditing({ id, source: 'outline' })
  }
}
