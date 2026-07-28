def merge_fields(base, local, remote):
    return {"value": dict(remote), "conflicts": []}
