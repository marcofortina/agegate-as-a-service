#!/bin/bash
echo "=== Age Gate Integration Test ==="

NODEPORT=$(kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.spec.ports[0].nodePort}')

echo "1. Health check..."
curl -s http://agegate.local:${NODEPORT}/health

echo "2. Onboarding page..."
curl -s http://agegate.local:${NODEPORT}/onboarding | head -n 10

echo "3. Register new client (demo)..."
curl -s -u admin:agegate2026 -X POST http://agegate.local:${NODEPORT}/api/register -H "Content-Type: application/json" -d '{"client_id":"test-client-22"}'

echo "Test completed."
