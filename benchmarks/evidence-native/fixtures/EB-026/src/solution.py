def sequence_relation(sequence, position, bits):
    if sequence == position:
        return "available"
    return "future" if sequence > position else "stale"
