def accept_chunk(state, offset, data, digest):
    state["data"] += data
    state["offset"] += len(data)
    return state
