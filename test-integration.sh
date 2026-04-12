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

# Step 1: Login to obtain session cookie
LOGIN_PAGE=$(curl -s -c "${COOKIE_JAR}" "${BASE_URL}/login")
LOGIN_CSRF=$(printf '%s' "${LOGIN_PAGE}" | grep -oP 'name="_csrf" value="\K[^"]+')

curl -s -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" -X POST "${BASE_URL}/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "_csrf=${LOGIN_CSRF}" \
  --data-urlencode "user=admin" \
  --data-urlencode "pass=agegate2026" >/dev/null

# Step 2: Get fresh CSRF token (this also sets the x-csrf-token cookie)
CSRF_RESPONSE=$(curl -s -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" "${BASE_URL}/csrf-token")
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | jq -r '.csrfToken')

echo "Admin CSRF token: ${CSRF_TOKEN}"

# Step 3: Register a new client with proper CSRF cookie + header
echo "Registering client..."
REGISTER_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" \
  -X POST "${BASE_URL}/api/v1/register" \
  -H "Content-Type: application/json" \
  -H "CSRF-Token: ${CSRF_TOKEN}" \
  -d "{\"client_id\":\"test-client-$(date +%s)\"}")

HTTP_STATUS=$(echo "$REGISTER_RESPONSE" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
BODY=$(echo "$REGISTER_RESPONSE" | sed 's/HTTP_STATUS:[0-9]*//')

echo "HTTP Status: $HTTP_STATUS"
echo "Response body: $BODY"

if [ "$HTTP_STATUS" -ne 200 ]; then
  echo "❌ Registration failed with status $HTTP_STATUS"
  echo "$BODY"
  exit 1
fi

API_KEY=$(echo "$BODY" | jq -r '.api_key')

if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
  echo "❌ Failed to extract API key"
  exit 1
fi

echo "Generated API Key: ${API_KEY}"

echo "4. Test age verification (should pass)..."
curl -s -X POST ${BASE_URL}/api/v1/verify \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"test-client","threshold":18}' | jq .

echo "5. Test rate limiting (rapid requests)..."
for i in {1..5}; do
  curl -s -X POST ${BASE_URL}/api/v1/verify \
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
