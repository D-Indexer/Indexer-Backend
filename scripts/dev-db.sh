#!/usr/bin/env sh
set -eu

docker run --name folder-postgres \
  -p 5432:5432 \
  -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=folder_db \
  postgres:16
