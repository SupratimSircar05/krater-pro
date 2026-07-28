export function visibleWindow(rowCount, rowHeight, scrollTop, viewportHeight, overscan) {
  return {
    start: Math.floor(scrollTop / rowHeight),
    end: Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  };
}
