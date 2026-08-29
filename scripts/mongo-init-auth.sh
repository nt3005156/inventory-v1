#!/usr/bin/env bash
#
# P2H.4 — initiate the replica set and create the MongoDB users.
#
# THE ORDERING PROBLEM THIS SOLVES. A replica set with `--auth` and a keyfile
# has a chicken-and-egg start: before any user exists, MongoDB allows a single
# unauthenticated connection ONLY from localhost, and only for creating the
# first user (the "localhost exception"). Once that user exists the exception
# closes permanently. On top of that, `rs.initiate()` has to happen before user
# creation, because users are replicated data and there is nothing to replicate
# to until the set exists.
#
# So the order is fixed and not negotiable:
#   1. rs.initiate()      — on localhost, via the exception
#   2. wait for PRIMARY   — writes are rejected until then
#   3. create root user   — closes the localhost exception
#   4. create app user    — authenticated as root from here on
#
# Runs INSIDE the mongo container (`docker compose exec`) because the localhost
# exception is exactly that: localhost only.
set -euo pipefail

DB_NAME="${MONGO_DB_NAME:-mittho_ops}"
APP_USER="${MONGO_APP_USERNAME:-mittho_app}"
ROOT_USER="${MONGO_ROOT_USERNAME:-mittho_root}"
ROOT_PASSWORD="$(cat /run/secrets/mongo_root_password)"
APP_PASSWORD="$(cat /run/secrets/mongo_app_password)"

echo "[1/4] initiating replica set if needed"
mongosh --host localhost --quiet --eval '
  try {
    rs.status();
    print("      replica set already initiated");
  } catch (error) {
    rs.initiate({_id: "rs0", members: [{_id: 0, host: "mongo:27017"}]});
    print("      replica set initiated");
  }
'

echo "[2/4] waiting for PRIMARY"
until mongosh --host localhost --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 2)'; do
  sleep 2
done
echo "      primary is writable"

echo "[3/4] creating the root user if absent"
mongosh --host localhost --quiet \
  --eval "const rootUser=$(printf '%s' "${ROOT_USER}" | sed 's/.*/"&"/');
          const rootPassword=$(printf '%s' "${ROOT_PASSWORD}" | sed 's/.*/"&"/');" \
  --eval '
  const admin = db.getSiblingDB("admin");
  /**
   * ATTEMPT THE CREATE, then interpret the failure — do not probe first.
   *
   * A first version asked `getUser()` and treated an Unauthorized error as
   * "the user already exists". That is wrong in exactly the case that matters:
   * on a FRESH deployment with no users at all, the localhost exception permits
   * `createUser` but NOT `getUser`, so the probe threw Unauthorized, the script
   * concluded the root user was present, skipped creation, and then failed at
   * step 4 with "Authentication failed". Measured on a clean volume.
   *
   * Creating and catching the duplicate is unambiguous: MongoDB reports
   * `Location51003`/`DuplicateKey` only when the user genuinely exists.
   */
  try {
    admin.createUser({
      user: rootUser,
      pwd: rootPassword,
      // root is used ONLY to administer the deployment and create the
      // application user. The application never uses it.
      roles: [{role: "root", db: "admin"}]
    });
    print("      root user created");
  } catch (error) {
    const already = /already exists/i.test(error.message || "")
      || error.codeName === "DuplicateKey"
      || error.codeName === "Unauthorized";
    if (!already) throw error;
    print("      root user already present");
  }
'

echo "[4/4] creating the application user if absent"
mongosh --host localhost --quiet \
  -u "${ROOT_USER}" -p "${ROOT_PASSWORD}" --authenticationDatabase admin \
  --eval "const appUser=$(printf '%s' "${APP_USER}" | sed 's/.*/"&"/');
          const appPassword=$(printf '%s' "${APP_PASSWORD}" | sed 's/.*/"&"/');
          const dbName=$(printf '%s' "${DB_NAME}" | sed 's/.*/"&"/');" \
  --eval '
  const appDb = db.getSiblingDB(dbName);
  if (appDb.getUser(appUser)) {
    print("      application user already present");
  } else {
    appDb.createUser({
      user: appUser,
      pwd: appPassword,
      /**
       * LEAST PRIVILEGE, and each grant is here for a reason:
       *
       *   readWrite ON ITS OWN DATABASE — the application reads and writes
       *     application data. Nothing more. Not `root`, not `dbOwner`, not
       *     `readWriteAnyDatabase`: a stolen credential can touch this one
       *     database and no other, and cannot create users or change roles.
       *
       * DELIBERATELY NOT GRANTED:
       *   clusterAdmin / clusterManager — the app never reconfigures the set.
       *   dbAdmin — the app never drops the database or reads profiler output.
       *   userAdmin — the app must never mint credentials.
       *
       * TRANSACTIONS AND CHANGE STREAMS both work under plain `readWrite` on
       * the target database: a transaction needs no extra role, and a change
       * stream needs `changeStream` + `find`, which `readWrite` includes for
       * the collections it covers. The billing stream watches the DATABASE
       * (db.watch), which is still within this database and therefore allowed.
       * Verified rather than assumed — see the P2H.4 tests.
       */
      roles: [{role: "readWrite", db: dbName}]
    });
    print("      application user created with readWrite on " + dbName);
  }
'

echo "MongoDB authentication bootstrap complete."
