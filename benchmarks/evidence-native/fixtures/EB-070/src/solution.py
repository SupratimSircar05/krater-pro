def apply_stream_event(state, event):
    state["last_id"] = event["id"]
    state["text"] += event.get("chunk", "")
    return state
