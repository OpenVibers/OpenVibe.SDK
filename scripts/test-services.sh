#!/usr/bin/env bash
# PostgreSQL 18 + PgBouncer (transaction pooling, SCRAM) + Valkey 9 in containers, the production data role's
# shape (ADR-035), for integration tests of openvibe-sdk/db, cache, queue, pubsub and limits.
#
#   scripts/test-services.sh up      start (or reuse) and print the env to export
#   scripts/test-services.sh down    remove the containers (and their data volumes)
#
# The data is throwaway: `up` rebuilds the test database when it has grown past OV_TEST_PG_MAX_GB (5) and nothing is
# connected to it (2026-10-03: runs killed before close() had left 4,382 schemas, 19 GB; createTestDb now sweeps those
# too), and every container is removed with its anonymous volume, which a plain `rm -f` used to orphan (133 of them).
#
# Tests read OV_TEST_PG_URL (through PgBouncer), OV_TEST_PG_DIRECT_URL and OV_TEST_VALKEY_URL; without them the
# integration cases print "<label>: skipped (…)" and the suite still runs on PGlite and the memory stores.
# Every test process gets a role of its own, so PgBouncer holds a pool per role: idle server connections close after
# 5 s and one database takes at most 120, or a service with many test files runs PostgreSQL out of connections.
# ovsdk-pg gets a 1 GB /dev/shm: Docker's 64 MB default overflows when parallel test databases resize shared memory (53100).
set -euo pipefail
NET=ovsdk-test; PW=ovtestpw
case "${1:-up}" in
up)
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
  # Too big and idle: a fresh empty database (only with no backend on it at all, so no running suite loses its schema).
  # Count every ovtest backend, `ov` included: a live run's admin connection and its per-run roles all count, and
  # DROP DATABASE ... WITH (FORCE) would terminate them.
  size=$(docker exec ovsdk-pg psql -U ov -d postgres -Atc "SELECT pg_database_size('ovtest')" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt $(( ${OV_TEST_PG_MAX_GB:-5} * 1024 * 1024 * 1024 )) ]; then
    busy=$(docker exec ovsdk-pg psql -U ov -d postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'ovtest'" 2>/dev/null || echo 1)
    if [ "${busy:-1}" = 0 ] && docker exec ovsdk-pg psql -U ov -d postgres -qc "DROP DATABASE ovtest WITH (FORCE)" >/dev/null 2>&1; then
      docker exec ovsdk-pg psql -U ov -d postgres -qc "CREATE DATABASE ovtest OWNER ov" >/dev/null && echo "test-services: ovtest was $(( size / 1024 / 1024 / 1024 )) GB: rebuilt empty" >&2
    fi
  fi
  echo "export OV_TEST_PG_URL=postgres://ov:$PW@127.0.0.1:56432/ovtest"
  echo "export OV_TEST_PG_DIRECT_URL=postgres://ov:$PW@127.0.0.1:55432/ovtest"
  echo "export OV_TEST_VALKEY_URL=redis://127.0.0.1:56379/0"
  ;;
down) docker rm -f -v ovsdk-pg ovsdk-pgbouncer ovsdk-valkey >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; echo removed ;;
*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
