class Arena:
    def __init__(self, capacity):
        self.capacity = capacity
        self.items = []

    def allocate(self, size, destructor):
        self.items.append((size, destructor))
        return len(self.items) - 1

    def reset(self):
        for _, destructor in self.items:
            destructor()
        self.items = []
