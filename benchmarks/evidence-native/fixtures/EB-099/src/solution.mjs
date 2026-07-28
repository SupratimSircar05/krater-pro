export function mergePlans(plans) {
  return { merged: plans.flatMap((plan) => plan.edits), conflicts: [] };
}
