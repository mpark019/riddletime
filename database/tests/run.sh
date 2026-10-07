#!/bin/sh

set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
container_name="riddletime-test-postgres-$$"
host_port=${RIDDLETIME_TEST_PORT:-5433}
owner_password=riddle_test_owner
app_password=riddle_test_app
container_started=false

cleanup() {
  if [ "$container_started" = true ]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run the database-backed test suite." >&2
  exit 1
fi

echo "Starting disposable PostgreSQL 17 on localhost:$host_port..."
container_started=true
docker run --rm --detach \
  --name "$container_name" \
  --tmpfs /var/lib/postgresql/data \
  --publish "127.0.0.1:$host_port:5432" \
  --env "POSTGRES_PASSWORD=$owner_password" \
  postgres:17 >/dev/null

attempt=0
until docker exec "$container_name" pg_isready --username postgres --dbname postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "PostgreSQL did not become ready." >&2
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 1
done

apply_sql_file() {
  sql_file=$1
  echo "Applying ${sql_file#"$repository_root"/}..."
  docker exec --interactive "$container_name" \
    psql --set ON_ERROR_STOP=1 --username postgres --dbname postgres \
    < "$sql_file" >/dev/null
}

apply_sql_file "$repository_root/database/tests/supabase_stand_ins.sql"

for migration in "$repository_root"/database/migrations/*.sql; do
  apply_sql_file "$migration"
done

docker exec "$container_name" \
  psql --set ON_ERROR_STOP=1 --username postgres --dbname postgres \
  --command "alter role riddle_app password '$app_password'" >/dev/null

apply_sql_file "$repository_root/database/tests/test_fixtures.sql"

echo "Running the web test suite..."
cd "$repository_root/web"
DATABASE_URL="postgresql://riddle_app:$app_password@127.0.0.1:$host_port/postgres" \
TEST_ADMIN_DATABASE_URL="postgresql://postgres:$owner_password@127.0.0.1:$host_port/postgres" \
npm run test:run -- "$@"
