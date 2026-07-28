def merge_lock_entry(left, right, constraints):
    return max((left, right), key=lambda item: item["version"])
