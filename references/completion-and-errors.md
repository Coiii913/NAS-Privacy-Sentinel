# Completion and errors

Only report a business result after the delegated expert returns `completed`. Report `failed`, `cancelled`, `waiting_user`, and `waiting_approval` as states, not as success. Preserve partial results and stop dependent work when required data is missing.
