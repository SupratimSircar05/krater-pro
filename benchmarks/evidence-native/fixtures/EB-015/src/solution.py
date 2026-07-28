class TtlCache:
    def __init__(self, clock):
        self.clock = clock
        self.values = {}

    def set(self, key, value, ttl):
        self.values[key] = (value, self.clock() + ttl)

    def get(self, key):
        item = self.values.get(key)
        if item is None:
            return None
        value, expires_at = item
        return value if self.clock() <= expires_at else None
