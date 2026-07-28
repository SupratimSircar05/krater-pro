def has_quorum(old_voters, new_voters, acknowledgements, joint):
    voters = set(old_voters) | set(new_voters)
    return len(voters & set(acknowledgements)) > len(voters) // 2
