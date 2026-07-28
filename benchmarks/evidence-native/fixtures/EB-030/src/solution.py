def recover_delimiters(source):
    missing = []
    for opening, closing in (("(", ")"), ("[", "]"), ("{", "}")):
        missing.extend([closing] * max(0, source.count(opening) - source.count(closing)))
    return {"source": source + "".join(missing), "diagnostics": missing}
