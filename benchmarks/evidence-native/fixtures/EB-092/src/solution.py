def handle_failure(message, attempt, maximum_attempts, error):
    return {"action": "retry", "attempt": attempt + 1, "message": message}
