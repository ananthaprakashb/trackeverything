#!/usr/bin/env bash
set -euo pipefail

API_URL="${1:-https://track-everything-api-854374277452.us-west1.run.app}"
APP_URL="${2:-https://ananthaprakashb.github.io/trackeverything/}"

echo "Testing backend health..."
HEALTH=$(curl -fsS "$API_URL/health")
echo "$HEALTH"

echo "Testing OAuth redirect..."
OAUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/auth/google")
if [[ "$OAUTH_STATUS" != "302" && "$OAUTH_STATUS" != "303" ]]; then
  echo "Expected OAuth redirect, received HTTP $OAUTH_STATUS" >&2
  exit 1
fi

echo "Testing frontend availability..."
FRONTEND_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$APP_URL")
if [[ "$FRONTEND_STATUS" != "200" ]]; then
  echo "Expected frontend HTTP 200, received $FRONTEND_STATUS" >&2
  exit 1
fi

echo "Testing unauthenticated API protection..."
ME_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/api/me")
if [[ "$ME_STATUS" != "401" ]]; then
  echo "Expected /api/me HTTP 401 without a session, received $ME_STATUS" >&2
  exit 1
fi

DASH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/api/dashboard")
if [[ "$DASH_STATUS" != "401" ]]; then
  echo "Expected /api/dashboard HTTP 401 without a session, received $DASH_STATUS" >&2
  exit 1
fi

echo "Public smoke tests passed. Complete Google consent in the browser for the authenticated checks."
