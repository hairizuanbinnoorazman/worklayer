// Resolve snapshot UIDs to coordinates or focus elements

import { getUidMap } from './snapshot.js';

export async function resolveUidToCoords(cdpClient, webContentsId, uid) {
  const map = getUidMap();
  const backendNodeId = map.get(String(uid));
  if (!backendNodeId) {
    throw new Error(`UID ${uid} not found in snapshot. Take a new snapshot first.`);
  }

  // Resolve to a remote object
  const resolveResp = await cdpClient.sendCommand(webContentsId, 'DOM.resolveNode', {
    backendNodeId,
  });
  if (resolveResp.error) throw new Error(resolveResp.error);
  const objectId = resolveResp.result.object?.objectId;
  if (!objectId) throw new Error('Could not resolve node to remote object');

  // Get box model
  const boxResp = await cdpClient.sendCommand(webContentsId, 'DOM.getBoxModel', { objectId });
  if (boxResp.error) throw new Error(boxResp.error);
  const quad = boxResp.result.model?.content;
  if (!quad || quad.length < 8) throw new Error('Could not get box model for element');

  // quad is [x1,y1, x2,y2, x3,y3, x4,y4] — compute center
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

  return { x, y };
}

export async function focusUid(cdpClient, webContentsId, uid) {
  const map = getUidMap();
  const backendNodeId = map.get(String(uid));
  if (!backendNodeId) {
    throw new Error(`UID ${uid} not found in snapshot. Take a new snapshot first.`);
  }

  const resp = await cdpClient.sendCommand(webContentsId, 'DOM.focus', { backendNodeId });
  if (resp.error) throw new Error(resp.error);
}
