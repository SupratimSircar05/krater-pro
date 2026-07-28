def aggregate_failures(outcomes):
    failures = [item for item in outcomes if item.get("error")]
    return {"primary": failures[0]["error"] if failures else None, "suppressed": []}
