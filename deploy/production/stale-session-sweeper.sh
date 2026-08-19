#!/usr/bin/env bash
set -euo pipefail

# Mark interview sessions that started but went silent for over 24 hours as
# ABANDONED, so stale IN_PROGRESS rows never pile up or confuse re-entry.
# Installed as a systemd timer by install-stale-session-sweeper.sh.

DB_CONTAINER=${AURAL_DB_CONTAINER:-supabase_db_aural}
STALE_HOURS=${AURAL_STALE_HOURS:-24}

docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c \
  "UPDATE sessions SET status = 'ABANDONED', \"updatedAt\" = now() WHERE status = 'IN_PROGRESS' AND \"lastActivityAt\" < now() - interval '${STALE_HOURS} hours';"
