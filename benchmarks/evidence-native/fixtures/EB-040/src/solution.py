def migration_plan(null_count, invalid_count):
    return ["set-not-null", "backfill", "validate"]
