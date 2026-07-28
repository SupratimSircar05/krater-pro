def chunks(values, size):
    for start in range(0, len(values) + 1, size):
        yield values[start:start + size]
