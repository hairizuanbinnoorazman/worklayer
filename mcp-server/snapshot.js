// Accessibility tree snapshot formatter
// Assigns sequential UIDs and maintains a UID -> backendDOMNodeId map

let uidCounter = 0;
let uidMap = new Map(); // uid -> backendDOMNodeId

export function getUidMap() {
  return uidMap;
}

export function resetUidMap() {
  uidCounter = 0;
  uidMap = new Map();
}

export async function takeSnapshot(cdpClient, webContentsId) {
  resetUidMap();

  const resp = await cdpClient.sendCommand(webContentsId, 'Accessibility.getFullAXTree', {});
  if (resp.error) throw new Error(resp.error);

  const nodes = resp.result.nodes;
  if (!nodes || nodes.length === 0) return '(empty accessibility tree)';

  // Build parent->children map
  const childMap = new Map();
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.childIds) {
      childMap.set(node.nodeId, node.childIds);
    }
  }

  // Find root
  const rootNode = nodes[0];

  const lines = [];
  function walk(nodeId, depth) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value || '';
    // Skip ignored/none nodes but still walk children
    if (node.ignored || role === 'none') {
      const children = childMap.get(nodeId) || [];
      for (const childId of children) walk(childId, depth);
      return;
    }

    const uid = ++uidCounter;
    if (node.backendDOMNodeId) {
      uidMap.set(String(uid), node.backendDOMNodeId);
    }

    const name = node.name?.value || '';
    const value = node.value?.value;
    const indent = '  '.repeat(depth);

    let line = `${indent}[${uid}] ${role}`;
    if (name) line += ` "${name}"`;
    if (value !== undefined && value !== '') line += ` value="${value}"`;

    // Add useful properties
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'checked' && prop.value?.value) {
          line += ` checked=${prop.value.value}`;
        }
        if (prop.name === 'disabled' && prop.value?.value === true) {
          line += ` disabled`;
        }
        if (prop.name === 'expanded' && prop.value?.value !== undefined) {
          line += ` expanded=${prop.value.value}`;
        }
        if (prop.name === 'selected' && prop.value?.value === true) {
          line += ` selected`;
        }
        if (prop.name === 'focused' && prop.value?.value === true) {
          line += ` focused`;
        }
      }
    }

    lines.push(line);

    const children = childMap.get(nodeId) || [];
    for (const childId of children) walk(childId, depth + 1);
  }

  walk(rootNode.nodeId, 0);
  return lines.join('\n');
}
