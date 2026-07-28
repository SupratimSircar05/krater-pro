export function postTransaction(ledger, transaction) {
  return { ...ledger, entries: [...ledger.entries, ...transaction.entries] };
}
