#!/usr/bin/env bash
#
# P2H.4 — generate MongoDB credentials and the replica-set keyfile.
#
# WHY A SCRIPT AND NOT COMMITTED VALUES. A password in `docker-compose.yml` or
# `.env.example` is a password every deployment shares and every reader of the
# repository knows. This generates a fresh one per deployment into files that
# are git-ignored, so the credential exists only on the host that uses it.
#
# WHAT IT PRODUCES
#   secrets/mongo_keyfile          shared secret that lets replica-set members
#                                  authenticate to EACH OTHER. MongoDB refuses
#                                  to start with `--auth` on a replica set
#                                  without one, and insists on 0400/0600.
#   secrets/mongo_root_password    the bootstrap/root credential, used ONCE to
#                                  create the application user and then only
#                                  for administration.
#   secrets/mongo_app_password     the application's own credential.
#   secrets/mongodb_uri            the full connection string the API reads via
#                                  MONGODB_URI_FILE, so the password is never
#                                  an environment variable that `docker inspect`
#                                  would print.
#
# Idempotent: existing files are left alone, so re-running never invalidates a
# live deployment's credentials.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${ROOT_DIR}/secrets"
DB_NAME="${MONGO_DB_NAME:-mittho_ops}"
APP_USER="${MONGO_APP_USERNAME:-mittho_app}"
ROOT_USER="${MONGO_ROOT_USERNAME:-mittho_root}"

mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

# A password with no shell-hostile or URI-reserved characters, so it can be
# embedded in a connection string without percent-encoding surprises.
random_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48
}

write_secret() {
  local path="$1" value="$2"
  if [[ -f "${path}" ]]; then
    echo "  kept    $(basename "${path}") (already exists)"
    return
  fi
  printf '%s' "${value}" > "${path}"
  chmod 600 "${path}"
  echo "  created $(basename "${path}")"
}

echo "Generating MongoDB credentials in ${SECRETS_DIR}"

# The keyfile is base64 so it stays within MongoDB's accepted character set.
if [[ -f "${SECRETS_DIR}/mongo_keyfile" ]]; then
  echo "  kept    mongo_keyfile (already exists)"
else
  openssl rand -base64 756 > "${SECRETS_DIR}/mongo_keyfile"
  echo "  created mongo_keyfile"
fi
# MongoDB REFUSES to start if the keyfile is group- or world-readable, AND the
# mongod process drops to uid 999 (mongodb) inside the container. Both must
# hold at once, which is the fiddly part:
#
#   chmod 400 owned by the host user  -> mongod (999) cannot read it:
#       "error opening file: /run/secrets/mongo_keyfile: bad file"
#   chmod 444                          -> readable, but mongod refuses it as
#                                         too permissive.
#
# So ownership has to become 999. Measured both failure modes before settling
# on this. `sudo` is attempted because the host user is usually not root; if it
# is unavailable the script says so plainly rather than producing a keyfile
# that silently fails at startup.
chmod 400 "${SECRETS_DIR}/mongo_keyfile"
if [[ "$(id -u)" == "0" ]]; then
  chown 999:999 "${SECRETS_DIR}/mongo_keyfile"
elif sudo -n chown 999:999 "${SECRETS_DIR}/mongo_keyfile" 2>/dev/null; then
  :
else
  echo "  WARNING mongo_keyfile is owned by $(id -un), but mongod runs as uid 999."
  echo "          Run: sudo chown 999:999 ${SECRETS_DIR}/mongo_keyfile"
  echo "          MongoDB will refuse to start until this is done."
fi

write_secret "${SECRETS_DIR}/mongo_root_password" "$(random_password)"
write_secret "${SECRETS_DIR}/mongo_app_password"  "$(random_password)"

APP_PASSWORD="$(cat "${SECRETS_DIR}/mongo_app_password")"

# The application's connection string, written as a file so the password never
# appears in `docker inspect` output or a process environment listing.
#
# `authSource` is the DATABASE THE USER LIVES IN. The application user is
# created inside its own database rather than `admin`, so a credential leak
# grants nothing outside that database.
if [[ -f "${SECRETS_DIR}/mongodb_uri" ]]; then
  echo "  kept    mongodb_uri (already exists)"
else
  printf 'mongodb://%s:%s@mongo:27017/%s?replicaSet=rs0&authSource=%s' \
    "${APP_USER}" "${APP_PASSWORD}" "${DB_NAME}" "${DB_NAME}" \
    > "${SECRETS_DIR}/mongodb_uri"
  chmod 600 "${SECRETS_DIR}/mongodb_uri"
  echo "  created mongodb_uri"
fi

echo
echo "Done. These files are git-ignored and must be backed up separately."
echo "Rotate with: rm secrets/mongo_app_password secrets/mongodb_uri && $0"
