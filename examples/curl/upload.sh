#!/usr/bin/env sh
set -eu

API_URL="${FOLDER_API_URL:-http://localhost:3000}"
FILE_PATH="${1:?usage: examples/curl/upload.sh <file-path>}"

curl -X POST "$API_URL/upload" \
  -F "file=@${FILE_PATH}"
