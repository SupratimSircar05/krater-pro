def coalesce_events(events):
    return sorted(set((event["path"], event["kind"]) for event in events))
