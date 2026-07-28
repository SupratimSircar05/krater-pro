def verify_bytecode(program):
    depth = 0
    for instruction in program:
        depth += instruction.get("push", 0) - instruction.get("pop", 0)
    return depth >= 0
