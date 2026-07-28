def split_page(keys, values):
    middle = len(keys) // 2
    return {
        "left": (keys[:middle], values[:middle]),
        "separator": keys[middle],
        "right": (keys[middle:], values[middle:]),
    }
