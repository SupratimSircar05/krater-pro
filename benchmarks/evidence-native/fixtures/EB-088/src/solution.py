def transition_breaker(state, event, now, config):
    if event == "failure":
        state["failures"] += 1
    if state["failures"] >= config["threshold"]:
        state["mode"] = "open"
    return state
