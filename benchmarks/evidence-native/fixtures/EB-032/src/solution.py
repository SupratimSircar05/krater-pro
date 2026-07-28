def place_phi(def_blocks, dominance_frontier, live_in):
    return sorted({block for source in def_blocks for block in dominance_frontier.get(source, [])})
