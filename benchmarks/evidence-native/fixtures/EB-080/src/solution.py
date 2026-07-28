def consume_frames(frames):
    return b"".join(frame.get("payload", b"") for frame in frames)
