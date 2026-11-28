#!/usr/bin/env sh
# Run the same checks as CI (minus the Docker build): typecheck, lint, test, bundle build.
set -eu

npm run check
npm run build