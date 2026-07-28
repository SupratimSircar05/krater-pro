def apply_edits(text, edits):
    for edit in edits:
        text = text[:edit["start"]] + edit["text"] + text[edit["end"]:]
    return text
