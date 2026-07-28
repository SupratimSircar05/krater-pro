def detect_losses(sent_packets, largest_acked, now, packet_threshold, time_threshold):
    return [
        packet["number"] for packet in sent_packets
        if packet["number"] < largest_acked
    ]
