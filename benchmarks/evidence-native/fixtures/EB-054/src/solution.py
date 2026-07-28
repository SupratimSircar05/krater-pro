def safe_archive_member(name, kind="file", target=None):
    return not name.startswith("/") and ".." not in name
