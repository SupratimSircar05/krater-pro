def can_access(capability, operation, path, now):
    return capability["operation"] == operation and path.startswith(capability["root"])
