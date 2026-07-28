export function moveNode(nodes, nodeId, parentId, index) {
  const node = nodes.find((item) => item.id === nodeId);
  node.parentId = parentId;
  node.index = index;
  return nodes;
}
