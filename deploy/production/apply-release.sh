#!/usr/bin/env bash
set -Eeuo pipefail

# Apply an immutable Aural release artifact on the interview tool machine.
# Invoked by deploy/release.core.ps1 as:
#   apply-release.sh <artifact> <sha256> <revision>
# Layout created on first run (the legacy /root/aural-oss tree is never
# modified and stays as the final rollback target):
#   /root/aural/releases/<sha>   immutable release directories
#   /root/aural/current          symlink to the active release
#   /root/aural/env/.env.local   runtime secrets, linked into releases
#   systemd drop-ins repoint both aural units at /root/aural/current

if [ "$#" -ne 3 ]; then
  echo "usage: apply-release.sh <artifact> <sha256> <revision>" >&2
  exit 2
fi

ARTIFACT=$(realpath "$1")
EXPECTED_DIGEST=$2
REVISION=$3

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "full revision required" >&2; exit 2; }
[[ "$EXPECTED_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "lowercase SHA256 required" >&2; exit 2; }
[ -f "$ARTIFACT" ] || { echo "artifact not found: $ARTIFACT" >&2; exit 1; }
[ "${OPRUN_AURAL_RELEASE_APPROVED_SHA:-}" = "$REVISION" ] || {
  echo "approved release SHA mismatch" >&2
  exit 1
}

AURAL_HOME=${OPRUN_AURAL_HOME:-/root/aural}
RELEASES="$AURAL_HOME/releases"
RELEASE_FINAL="$RELEASES/$REVISION"
CURRENT="$AURAL_HOME/current"
ENV_DIR="$AURAL_HOME/env"
LEGACY_DIR=${OPRUN_AURAL_LEGACY_DIR:-/root/aural-oss}
LOCK=/run/lock/aural-deploy.lock
BACKUP_ROOT="$AURAL_HOME/deploy-backups"
KEEP_RELEASES=${OPRUN_AURAL_KEEP_RELEASES:-3}
OPENAI_VOICE_UNIT=/etc/systemd/system/aural-openai-voice.service
FALLBACK_CONFIGURED=false

[ ! -e "$RELEASE_FINAL" ] || { echo "immutable release exists: $RELEASE_FINAL" >&2; exit 1; }
[ "$(sha256sum "$ARTIFACT" | awk '{print $1}')" = "$EXPECTED_DIGEST" ] || {
  echo "artifact checksum mismatch" >&2
  exit 1
}

exec 9>"$LOCK"
flock -n 9 || { echo "another Aural release is active" >&2; exit 1; }

# Runtime secrets live outside releases and are linked in; never shipped,
# never logged. Bootstrap copies the legacy file exactly once.
mkdir -p "$RELEASES" "$ENV_DIR" "$BACKUP_ROOT"
if [ ! -f "$ENV_DIR/.env.local" ]; then
  [ -f "$LEGACY_DIR/.env.local" ] || { echo "runtime env missing: $LEGACY_DIR/.env.local" >&2; exit 1; }
  install -m 0600 "$LEGACY_DIR/.env.local" "$ENV_DIR/.env.local"
fi
if grep -Eq '^AZURE_OPENAI_ENDPOINT=.+' "$ENV_DIR/.env.local" && \
   grep -Eq '^AZURE_OPENAI_API_KEY=.+' "$ENV_DIR/.env.local"; then
  FALLBACK_CONFIGURED=true
fi

STAMP=$(date +%Y%m%d-%H%M%S)-$$
STAGING=$(mktemp -d "$RELEASES/.${REVISION}.next.XXXXXX")
SNAPSHOT="$BACKUP_ROOT/pre-$REVISION-$STAMP"
# Only report a previous target when the current symlink actually exists;
# readlink -f on a missing path still prints the path itself.
PREVIOUS_TARGET=""
[ -L "$CURRENT" ] && PREVIOUS_TARGET=$(readlink -f "$CURRENT")
DROPINS_INSTALLED=false
CURRENT_SWITCHED=false
mkdir -p "$SNAPSHOT"
systemctl cat aural.service aural-voice.service aural-openai-voice.service >"$SNAPSHOT/units.before" 2>&1 || true
[ -d /etc/systemd/system/aural.service.d ] && mkdir -p "$SNAPSHOT/dropins" && cp -a /etc/systemd/system/aural.service.d "$SNAPSHOT/dropins/"
[ -d /etc/systemd/system/aural-voice.service.d ] && mkdir -p "$SNAPSHOT/dropins" && cp -a /etc/systemd/system/aural-voice.service.d "$SNAPSHOT/dropins/"
[ -f "$OPENAI_VOICE_UNIT" ] && cp -a "$OPENAI_VOICE_UNIT" "$SNAPSHOT/aural-openai-voice.service.before" || touch "$SNAPSHOT/openai-unit-was-absent"
systemctl is-enabled --quiet aural-openai-voice.service && touch "$SNAPSHOT/openai-unit-was-enabled" || true
[ -n "$PREVIOUS_TARGET" ] && printf '%s\n' "$PREVIOUS_TARGET" >"$SNAPSHOT/current.before"

cleanup() {
  rm -rf -- "$STAGING"
}
rollback() {
  local rc=$?
  trap - ERR EXIT
  set +e
  if [ "$CURRENT_SWITCHED" = true ]; then
    if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
      ln -s "$PREVIOUS_TARGET" "${CURRENT}.rollback-$$"
      mv -Tf "${CURRENT}.rollback-$$" "$CURRENT"
    else
      rm -f -- "$CURRENT"
    fi
  fi
  if [ "$DROPINS_INSTALLED" = true ]; then
    rm -rf /etc/systemd/system/aural.service.d /etc/systemd/system/aural-voice.service.d
    [ -d "$SNAPSHOT/dropins/aural.service.d" ] && cp -a "$SNAPSHOT/dropins/aural.service.d" /etc/systemd/system/
    [ -d "$SNAPSHOT/dropins/aural-voice.service.d" ] && cp -a "$SNAPSHOT/dropins/aural-voice.service.d" /etc/systemd/system/
  fi
  if [ -f "$SNAPSHOT/aural-openai-voice.service.before" ]; then
    cp -a "$SNAPSHOT/aural-openai-voice.service.before" "$OPENAI_VOICE_UNIT"
  else
    systemctl disable aural-openai-voice.service >/dev/null 2>&1 || true
    rm -f -- "$OPENAI_VOICE_UNIT"
  fi
  systemctl daemon-reload
  if [ -f "$SNAPSHOT/openai-unit-was-enabled" ]; then
    systemctl enable aural-openai-voice.service >/dev/null 2>&1 || true
  else
    systemctl disable aural-openai-voice.service >/dev/null 2>&1 || true
  fi
  systemctl restart aural.service aural-voice.service
  systemctl try-restart aural-openai-voice.service || true
  sleep 3
  curl -s -o /dev/null --max-time 8 http://127.0.0.1:3000/ || true
  echo "aural deploy failed; rolled back (snapshot: $SNAPSHOT)" >&2
  cleanup
  exit "$rc"
}
trap rollback ERR
trap cleanup EXIT

python3 - "$ARTIFACT" "$STAGING" "$REVISION" <<'PY'
import json
import sys
import tarfile
from pathlib import Path

archive, destination, expected = sys.argv[1:]
root = Path(destination).resolve()
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    for member in members:
        target = (root / member.name).resolve()
        if target != root and root not in target.parents:
            raise SystemExit("unsafe release archive path")
        if member.isdev() or member.isfifo():
            raise SystemExit("unsupported release archive member")
        if member.name not in {"manifest.json", "app"} and not member.name.startswith("app/"):
            raise SystemExit("unexpected release archive member")
    bundle.extractall(root, filter="data")
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
if manifest.get("schema") != "aural-release.v1" or manifest.get("revision") != expected:
    raise SystemExit("release identity mismatch")
for required in ("app/package.json", "app/.next/BUILD_ID", "app/server"):
    if not (root / required).exists():
        raise SystemExit(f"release incomplete: {required}")
PY

mv "$STAGING/app" "$RELEASE_FINAL"
rm -f "$STAGING/manifest.json"
rmdir "$STAGING"
chmod -R go-w "$RELEASE_FINAL"
ln -sfn "$ENV_DIR/.env.local" "$RELEASE_FINAL/.env.local"

DROPINS_INSTALLED=true
mkdir -p /etc/systemd/system/aural.service.d /etc/systemd/system/aural-voice.service.d
cat > /etc/systemd/system/aural.service.d/override.conf <<UNIT
[Service]
WorkingDirectory=$CURRENT
EnvironmentFile=-$ENV_DIR/.env.local
ExecStart=
ExecStart=/bin/bash -lc 'npm run start -- -H 0.0.0.0 -p 3000'
UNIT
cat > /etc/systemd/system/aural-voice.service.d/override.conf <<UNIT
[Service]
WorkingDirectory=$CURRENT
EnvironmentFile=-$ENV_DIR/.env.local
ExecStart=
ExecStart=/bin/bash -lc 'cd $CURRENT && npm run dev:voice'
UNIT
if [ "$FALLBACK_CONFIGURED" = true ]; then
  cat > "$OPENAI_VOICE_UNIT" <<UNIT
[Unit]
Description=Aural backup OpenAI voice relay
After=network-online.target aural.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$CURRENT
EnvironmentFile=-$ENV_DIR/.env.local
ExecStart=/bin/bash -lc 'cd $CURRENT && npm run dev:openai-voice'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
else
  systemctl disable aural-openai-voice.service >/dev/null 2>&1 || true
  rm -f -- "$OPENAI_VOICE_UNIT"
fi
systemctl daemon-reload
if [ "$FALLBACK_CONFIGURED" = true ]; then
  systemctl enable aural-openai-voice.service
fi

# Keep the stale-session sweeper current on every deploy (idempotent).
APPLY_DIR=$(dirname "$(readlink -f "$0")")
[ -f "$APPLY_DIR/install-stale-session-sweeper.sh" ] && \
  bash "$APPLY_DIR/install-stale-session-sweeper.sh" || true

ln -s "$RELEASE_FINAL" "${CURRENT}.next-$$"
mv -Tf "${CURRENT}.next-$$" "$CURRENT"
CURRENT_SWITCHED=true

REQUIRED_SERVICES=(aural.service aural-voice.service)
if [ "$FALLBACK_CONFIGURED" = true ]; then
  REQUIRED_SERVICES+=(aural-openai-voice.service)
fi
systemctl restart "${REQUIRED_SERVICES[@]}"
for _ in $(seq 1 20); do
  systemctl is-active --quiet "${REQUIRED_SERVICES[@]}" && curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3000/api/ready && break
  sleep 3
done
if ! systemctl is-active --quiet "${REQUIRED_SERVICES[@]}"; then
  echo "services not active after switch" >&2
  false
fi
if ! curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:3000/api/health; then
  echo "local health endpoint failed" >&2
  false
fi
if ! curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:3000/api/ready; then
  echo "local readiness endpoint failed" >&2
  false
fi
[ "$(readlink -f "$CURRENT")" = "$RELEASE_FINAL" ]
[ "$(cat "$RELEASE_FINAL/REVISION")" = "$REVISION" ]

# Retention: keep the newest $KEEP_RELEASES plus the active and legacy dirs.
mapfile -t OLD < <(ls -1t "$RELEASES" | tail -n +$((KEEP_RELEASES + 1)))
for candidate in "${OLD[@]:-}"; do
  [ -n "$candidate" ] || continue
  TARGET=$(readlink -f "$RELEASES/$candidate")
  [ "$TARGET" = "$RELEASE_FINAL" ] && continue
  [ "$TARGET" = "$PREVIOUS_TARGET" ] && continue
  rm -rf -- "$RELEASES/$candidate"
done

trap - ERR EXIT
cleanup
rm -f -- "$ARTIFACT"
printf 'revision=%s\n' "$REVISION"
printf 'artifact_sha256=%s\n' "$EXPECTED_DIGEST"
printf 'release=%s\n' "$RELEASE_FINAL"
printf 'previous=%s\n' "${PREVIOUS_TARGET:-none}"
printf 'rollback_switch_back=%s\n' "${PREVIOUS_TARGET:-$LEGACY_DIR}"
printf 'services=active\n'
printf 'fallback_voice_configured=%s\n' "$FALLBACK_CONFIGURED"
printf 'snapshot=%s\n' "$SNAPSHOT"
