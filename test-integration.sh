#!/bin/bash
set -e

echo "=== Age Gate Integration Test ==="

NODEPORT=$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.spec.ports[0].nodePort}')
BASE_URL="http://agegate.local:${NODEPORT}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

echo "1. Health check..."
curl -s ${BASE_URL}/health | jq .

echo "2. Onboarding page..."
curl -s ${BASE_URL}/onboarding | head -n 10

echo "3. Register new client..."
# Step 1: fetch login page and save session cookie
LOGIN_PAGE=$(curl -s -c "${COOKIE_JAR}" "${BASE_URL}/login")
LOGIN_CSRF=$(printf '%s' "${LOGIN_PAGE}" | grep -oP 'name="_csrf" value="\K[^"]+')

echo "Login CSRF token: ${LOGIN_CSRF}"

# Step 2: perform login
curl -s -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" -X POST "${BASE_URL}/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "_csrf=${LOGIN_CSRF}" \
  --data-urlencode "user=admin" \
  --data-urlencode "pass=agegate2026" >/dev/null

# Step 3: get CSRF token for admin actions
CSRF_TOKEN=$(curl -s -b "${COOKIE_JAR}" "${BASE_URL}/csrf-token" | jq -r '.csrfToken')
echo "Admin CSRF token: ${CSRF_TOKEN}"

# Step 4: register client
API_KEY=$(curl -s -b "${COOKIE_JAR}" -X POST "${BASE_URL}/api/register" \
  -H "Content-Type: application/json" \
  -H "CSRF-Token: ${CSRF_TOKEN}" \
  -d '{"client_id":"test-client-'$(date +%s)'"}' \
  | jq -r '.api_key')

echo "Generated API Key: ${API_KEY}"

if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
  echo "❌ Failed to get API key"
  exit 1
fi

echo "4. Test age verification (should pass)..."
curl -s -X POST ${BASE_URL}/verify \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"test-client","threshold":18}' | jq .

echo "5. Test rate limiting (rapid requests)..."
for i in {1..5}; do
  curl -s -X POST ${BASE_URL}/verify \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"client_id":"test-client","threshold":18}' | jq '.status'
done

echo "6. Check Prometheus metrics..."
curl -s -b "${COOKIE_JAR}" "${BASE_URL}/metrics" | grep agegate_ | head -10

echo "7. Test logout and session..."
curl -s -b "${COOKIE_JAR}" "${BASE_URL}/dashboard" | head -20
curl -s -b "${COOKIE_JAR}" "${BASE_URL}/logout" >/dev/null

echo "=== Integration test completed successfully ==="
