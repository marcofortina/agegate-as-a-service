#!/bin/bash
set -e

echo "=== Age Gate Integration Test ==="

NODEPORT=$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.spec.ports[0].nodePort}')
BASE_URL="http://agegate.local:${NODEPORT}"

echo "1. Health check..."
curl -s ${BASE_URL}/health | jq .

echo "2. Onboarding page..."
curl -s ${BASE_URL}/onboarding | head -n 10

echo "3. Register new client..."
# Step 1: login and save cookie
AUTH=$(echo -n 'admin:agegate2026' | base64)
curl -s -c cookies.txt "${BASE_URL}/dashboard?auth=${AUTH}" > /dev/null

# Step 2: get CSRF token
CSRF_TOKEN=$(curl -s -b cookies.txt ${BASE_URL}/dashboard \
  | grep -oP 'meta name="csrf-token" content="\K[^"]+')

echo "CSRF token: ${CSRF_TOKEN}"

# Step 3: register client
API_KEY=$(curl -s -b cookies.txt -X POST ${BASE_URL}/api/register \
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
curl -s -u admin:agegate2026 ${BASE_URL}/metrics | grep agegate_ | head -10

echo "7. Test logout and session..."
curl -s -c cookies.txt -X GET ${BASE_URL}/login
curl -s -b cookies.txt -X GET "${BASE_URL}/dashboard?auth=$(echo -n 'admin:agegate2026' | base64)" | head -20
curl -s -b cookies.txt -X GET ${BASE_URL}/logout

echo "=== Integration test completed successfully ==="
