export function nearestPoint(points, scales, target) {
  return points.reduce((best, point) => {
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    return !best || distance < best.distance ? { point, distance } : best;
  }, null).point;
}
