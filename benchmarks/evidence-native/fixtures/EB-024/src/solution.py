def allow_request(lease, now_monotonic, endpoint_class):
    return lease is not None and lease.get("tokens", 0) > 0
