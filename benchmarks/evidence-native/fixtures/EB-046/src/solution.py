def value_at(records, valid_at, recorded_at):
    matches = [
        row for row in records
        if row["valid_from"] <= valid_at < row["valid_to"]
    ]
    return matches[-1]["value"] if matches else None
