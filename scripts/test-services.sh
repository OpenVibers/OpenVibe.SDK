#!/usr/bin/env bash
# PostgreSQL 18 + PgBouncer (transaction pooling, SCRAM) + Valkey 9 in containers, the production data role's
# shape (ADR-035), for integration tests of openvibe-sdk/db, cache, queue, pubsub and limits.
#
#   scripts/test-services.sh up      start (or reuse) and print the env to export
#   scripts/test-services.sh down    remove the containers (and their data volumes)
#
# The data is throwaway: createTestDb sweeps abandoned schemas, and `down` removes the containers with their anonymous
# volumes. `up` must not rebuild a reused database: a live test may have no connection after its pool becomes idle.
#
# Tests read OV_TEST_PG_URL (through PgBouncer), OV_TEST_PG_DIRECT_URL and OV_TEST_VALKEY_URL; without them the
# integration cases print "<label>: skipped (…)" and the suite still runs on PGlite and the memory stores.
# Every test process gets a role of its own, so PgBouncer holds a pool per role: idle server connections close after
# 5 s and one database takes at most 120, or a service with many test files runs PostgreSQL out of connections.
# ovsdk-pg gets a 1 GB /dev/shm: Docker's 64 MB default overflows when parallel test databases resize shared memory (53100).
#
# Without Docker (a check job on a shared node: GitHub Actions' workflow run by act in host mode, no daemon and no root)
# the same three services start from local binaries as the current user, under one throwaway directory
# (OV_TEST_SERVICES_DIR, default $TMPDIR/ovsdk-services-<uid>), on the same ports with the same users, and `up` prints
# the same env: PostgreSQL 18 (initdb, SCRAM, fsync off), PgBouncer (transaction mode; each test role is looked up with
# auth_query, SCRAM passed through) and Valkey. OV_TEST_SERVICES=docker|local chooses; by default Docker is used when
# `docker info` answers. Ubuntu: apt install postgresql-18 pgbouncer valkey-server (their own services can stay off).
set -euo pipefail
NET=ovsdk-test; PW=ovtestpw

# The first executable called $1 in the places PostgreSQL, PgBouncer and Valkey install to (pgbouncer is in /usr/sbin),
# or only in OV_TEST_SERVICES_PATH's directories (colon-separated) when that is set.
local_bin() {
  local d dirs
  if [ -n "${OV_TEST_SERVICES_PATH:-}" ]; then
    IFS=: read -r -a dirs <<< "$OV_TEST_SERVICES_PATH"
  else
    dirs=(/usr/lib/postgresql/18/bin /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /usr/sbin /usr/local/sbin /usr/local/bin /usr/bin /opt/homebrew/bin)
  fi
  for d in "${dirs[@]}"; do
    if [ -x "$d/$1" ]; then echo "$d/$1"; return 0; fi
  done
  if [ -z "${OV_TEST_SERVICES_PATH:-}" ]; then command -v "$1" 2>/dev/null || true; fi
}
mode() {
  case "${OV_TEST_SERVICES:-}" in docker|local) echo "$OV_TEST_SERVICES"; return ;; esac
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker; else echo local; fi
}
LOCAL_DIR="${OV_TEST_SERVICES_DIR:-${TMPDIR:-/tmp}/ovsdk-services-$(id -u)}"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
pid_alive() { [ -s "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

local_up() {
  local D="$LOCAL_DIR" initdb pgctl psql pgb vk missing="" i
  initdb=$(local_bin initdb); pgctl=$(local_bin pg_ctl); psql=$(local_bin psql); pgb=$(local_bin pgbouncer); vk=$(local_bin valkey-server)
  [ -n "$initdb" ] && [ -n "$pgctl" ] && [ -n "$psql" ] || missing="$missing postgresql-18"
  [ -n "$pgb" ] || missing="$missing pgbouncer"
  [ -n "$vk" ] || missing="$missing valkey-server"
  if [ -n "$missing" ]; then
    echo "test-services: no Docker, and no local$missing to start instead" >&2
    exit 1
  fi
  mkdir -p "$D"; chmod 700 "$D"
  if ! port_open 55432; then
    if [ ! -s "$D/pg/PG_VERSION" ]; then
      printf '%s\n' "$PW" > "$D/pw"
      "$initdb" -D "$D/pg" -U ov --pwfile="$D/pw" --auth-host=scram-sha-256 --auth-local=scram-sha-256 -E UTF8 --no-instructions >/dev/null
      rm -f "$D/pw"
    fi
    "$pgctl" -D "$D/pg" -l "$D/pg.log" -w -t 60 -o "-c listen_addresses=127.0.0.1 -c port=55432 -c unix_socket_directories=$D -c max_connections=200 -c dynamic_shared_memory_type=mmap -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
    if ! PGPASSWORD=$PW "$psql" -h 127.0.0.1 -p 55432 -U ov -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = 'ovtest'" | grep -q 1; then
      PGPASSWORD=$PW "$psql" -h 127.0.0.1 -p 55432 -U ov -d postgres -qc "CREATE DATABASE ovtest" >/dev/null
    fi
  fi
  if ! pid_alive "$D/pgbouncer.pid"; then
    printf '"ov" "%s"\n' "$PW" > "$D/userlist.txt"
    cat > "$D/pgbouncer.ini" <<INI
[databases]
* = host=127.0.0.1 port=55432
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 56432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = $D/userlist.txt
auth_user = ov
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename = \$1
pool_mode = transaction
max_client_conn = 500
default_pool_size = 10
max_db_connections = 120
server_idle_timeout = 5
ignore_startup_parameters = extra_float_digits
pidfile = $D/pgbouncer.pid
logfile = $D/pgbouncer.log
INI
    "$pgb" -d -q "$D/pgbouncer.ini"
  fi
  if ! pid_alive "$D/valkey.pid"; then
    "$vk" --bind 127.0.0.1 --port 56379 --save "" --appendonly no --daemonize yes --dir "$D" --pidfile "$D/valkey.pid" --logfile "$D/valkey.log" >/dev/null
  fi
  for i in $(seq 1 40); do port_open 56432 && port_open 56379 && break; sleep 0.25; done
  port_open 56432 || { echo "test-services: PgBouncer did not start (see $D/pgbouncer.log)" >&2; exit 1; }
  port_open 56379 || { echo "test-services: Valkey did not start (see $D/valkey.log)" >&2; exit 1; }
}

local_down() {
  local D="$LOCAL_DIR" pgctl
  [ -d "$D" ] || return 0
  pgctl=$(local_bin pg_ctl)
  if [ -n "$pgctl" ] && [ -s "$D/pg/postmaster.pid" ]; then "$pgctl" -D "$D/pg" -m immediate stop >/dev/null 2>&1 || true; fi
  local f pid i
  for f in "$D/pgbouncer.pid" "$D/valkey.pid"; do
    pid_alive "$f" || continue
    pid=$(cat "$f"); kill "$pid" 2>/dev/null || true
    # Wait for it to exit: it may still be writing its log while the directory is removed.
    for i in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.125; done
  done
  rm -rf "$D" 2>/dev/null || { sleep 0.5; rm -rf "$D"; }
}

case "${1:-up}" in
up)
  if [ "$(mode)" = local ]; then
    local_up
    echo "export OV_TEST_PG_URL=postgres://ov:$PW@127.0.0.1:56432/ovtest"
    echo "export OV_TEST_PG_DIRECT_URL=postgres://ov:$PW@127.0.0.1:55432/ovtest"
    echo "export OV_TEST_VALKEY_URL=redis://127.0.0.1:56379/0"
    exit 0
  fi
  docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null
  if docker inspect ovsdk-pg >/dev/null 2>&1 && [ "$(docker inspect -f '{{.HostConfig.ShmSize}}' ovsdk-pg)" -lt 1073741824 ]; then
    # A reused ovsdk-pg from before --shm-size has the 64 MB default; remove it and PgBouncer (which points at it) so both start again.
    docker rm -f -v ovsdk-pg ovsdk-pgbouncer >/dev/null 2>&1 || true
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx ovsdk-pg; then
    docker rm -f -v ovsdk-pg >/dev/null 2>&1 || true
    docker run -d --name ovsdk-pg --network $NET -p 127.0.0.1:55432:5432 \
      --shm-size=1g \
      -e POSTGRES_USER=ov -e POSTGRES_PASSWORD=$PW -e POSTGRES_DB=ovtest -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
      postgres:18-alpine -c max_connections=200 >/dev/null
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx ovsdk-pgbouncer; then
    docker rm -f -v ovsdk-pgbouncer >/dev/null 2>&1 || true
    docker run -d --name ovsdk-pgbouncer --network $NET -p 127.0.0.1:56432:5432 \
      -e DATABASE_URL="postgres://ov:$PW@ovsdk-pg:5432/ovtest" -e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e MAX_CLIENT_CONN=500 -e DEFAULT_POOL_SIZE=10 \
      -e MAX_DB_CONNECTIONS=120 -e SERVER_IDLE_TIMEOUT=5 \
      edoburu/pgbouncer:latest >/dev/null
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx ovsdk-valkey; then
    docker rm -f -v ovsdk-valkey >/dev/null 2>&1 || true
    docker run -d --name ovsdk-valkey --network $NET -p 127.0.0.1:56379:6379 valkey/valkey:9-alpine >/dev/null
  fi
  for i in $(seq 1 60); do docker exec ovsdk-pg pg_isready -U ov -d ovtest >/dev/null 2>&1 && break; sleep 0.5; done
  echo "export OV_TEST_PG_URL=postgres://ov:$PW@127.0.0.1:56432/ovtest"
  echo "export OV_TEST_PG_DIRECT_URL=postgres://ov:$PW@127.0.0.1:55432/ovtest"
  echo "export OV_TEST_VALKEY_URL=redis://127.0.0.1:56379/0"
  ;;
down)
  local_down
  if command -v docker >/dev/null 2>&1; then
    docker rm -f -v ovsdk-pg ovsdk-pgbouncer ovsdk-valkey >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true
  fi
  echo removed ;;
*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
