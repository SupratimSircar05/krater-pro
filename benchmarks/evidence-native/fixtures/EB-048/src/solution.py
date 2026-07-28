def route_key(key, ranges):
    for item in ranges:
        if item["start"] <= key <= item["end"]:
            return item["shard"]
    return None
