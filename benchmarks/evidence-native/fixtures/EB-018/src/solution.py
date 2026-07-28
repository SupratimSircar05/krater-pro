ORDER = ["public", "proprietary", "pii", "secret"]

def join_labels(labels):
    if not labels:
        return "public"
    return min(labels, key=ORDER.index)
