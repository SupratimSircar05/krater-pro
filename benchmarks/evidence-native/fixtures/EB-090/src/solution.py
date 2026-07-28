def recover_queue(records):
    queue = []
    for record in records:
        if record["op"] == "enqueue":
            queue.append(record["value"])
        elif record["op"] == "dequeue" and queue:
            queue.pop(0)
    return queue
