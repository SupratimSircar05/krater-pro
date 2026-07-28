def execute_fault_plan(steps, faults):
    trace = []
    for step in steps:
        trace.append({"step": step, "fault": next((fault for fault in faults if fault["step"] == step), None)})
    return trace
