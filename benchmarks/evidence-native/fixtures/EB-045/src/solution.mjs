export function authorizeRow(context, row) {
  return context.role === "admin" || context.tenantId === row.tenantId;
}
