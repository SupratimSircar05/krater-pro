def command_is_safe(command):
    blocked = [";", "|", ">", "<"]
    return not any(token in command for token in blocked)
