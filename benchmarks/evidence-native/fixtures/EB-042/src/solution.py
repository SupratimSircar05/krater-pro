def reserve(state, sku, quantity, request_id):
    state["available"][sku] -= quantity
    state["requests"][request_id] = quantity
    return state
