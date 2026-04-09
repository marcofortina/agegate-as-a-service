# Integration Tests with Docker Compose

The project includes end‑to‑end integration tests that run against real TimescaleDB and Redis containers using Docker Compose.

## Prerequisites

- Docker installed and running
- Node.js 20+

## Running the tests

```bash
cd verifier-app
npm run test:integration-compose
```

What happens:
1. `docker-compose.test.yml` starts TimescaleDB (port 5433) and Redis (port 6380).
2. The application is launched as a separate Node.js process on port 8082.
3. `wait-on` ensures all services are ready before tests begin.
4. The test suite verifies:
   - Health endpoint
   - Admin authentication
   - Client registration (API key generation)
   - Age verification (mock backend)
   - Rate limiting (100 requests per minute)
   - API key revocation and rotation
   - Stats endpoint
5. After tests complete, containers are stopped and removed (`docker-compose down -v`).

## Writing new integration tests

Add new test files inside `test/integration/` with the suffix `.test.js`. Use the same pattern as `compose.test.js`.

## Troubleshooting

- If containers fail to start, check that ports 5433 and 6380 are free.
- To inspect logs during test execution, remove `stdio: 'pipe'` from the `spawn` call in the test file.
- Increase timeouts in `jest.integration.config.js` if needed.

## CI Integration

In GitHub Actions, ensure Docker is installed and the service containers are started before the test step.
