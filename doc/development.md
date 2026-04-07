# AgeGate as a Service - Development Guide

This guide explains how to set up local development, run tests, and work with the K3s lab for AgeGate-as-a-Service.

## Local Development (K3s Lab Ready)

```bash
cp .env.example .env
npm install --prefix verifier-app
npm run dev --prefix verifier-app
```

## Linting

```bash
npm run lint          # auto-fix issues
npm run lint:check    # check only, no auto-fix
```

## Testing

```bash
export TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD
export ADMIN_PASS=YOUR_ADMIN_PASSWORD

npm test                  # run once with coverage
npm run test:watch        # interactive watch mode
npm run test:integration  # run integration tests
```

Coverage report is generated in `verifier-app/coverage/`.

## K3s Lab Workflow

1. Create namespace:

```bash
kubectl create ns agegate
```

2. Deploy the application:

```bash
helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --values agegate-verifier/values.yaml \
  --set env.TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD \
  --set env.ADMIN_PASS=YOUR_ADMIN_PASSWORD
```

3. Run `npm test` locally before every push

## CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`) already runs:

* `npm ci`
* `npm run lint:check`
* `TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD ADMIN_PASS=YOUR_ADMIN_PASSWORD npm test`
* `helm lint`

All tests must pass before merging to `master`.
