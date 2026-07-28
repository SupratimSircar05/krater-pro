def reconcile_subscriptions(current, desired):
    return {"subscribe": [item for item in desired if item not in current], "unsubscribe": []}
