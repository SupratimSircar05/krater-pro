def consume_recovery(state, token_hash, now):
    if state["token_hash"] != token_hash:
        raise ValueError("invalid token")
    state["used"] = True
    return state
