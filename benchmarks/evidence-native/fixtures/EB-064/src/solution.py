def next_focus(modal_stack, current, focusables, backwards=False):
    flat = [item for values in focusables.values() for item in values]
    step = -1 if backwards else 1
    return flat[(flat.index(current) + step) % len(flat)]
