#!/usr/bin/env bash
set -euo pipefail

# Last-resort cleanup for sessions the voice relay could not finalize
# (e.g. relay restart orphaned them). The relay now persists
# COMPLETED/ABANDONED on farewell/disconnect/time-limit by itself;
# this sweeper only catches leftovers. Installed as a systemd timer
# by install-stale-session-sweeper.sh.

DB_CONTAINER=${AURAL_DB_CONTAINER:-supabase_db_aural}
STALE_HOURS=${AURAL_STALE_HOURS:-2}

# "lastActivityAt" IS NULL rows never matched the old predicate and piled up
# as zero-minute zombies; fall back to "createdAt" for them.
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c \
  "UPDATE sessions SET status = 'ABANDONED', \"updatedAt\" = now() WHERE status = 'IN_PROGRESS' AND COALESCE(\"lastActivityAt\", \"createdAt\") < now() - interval '${STALE_HOURS} hours';"
