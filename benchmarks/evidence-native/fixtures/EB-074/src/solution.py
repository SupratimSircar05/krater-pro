def verify_provenance(statement, expected):
    return statement["subject"]["sha256"] == expected["sha256"]
