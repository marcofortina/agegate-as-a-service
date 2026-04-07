# Age Gate as a Service

Italian anonymous age verification solution based on UE Blueprint (eIDAS 2.0).

---

## Key Features

* Fully anonymous age verification (AGCOM double anonymity)
* Multi-threshold support (18 / 21 / 25)
* Distributed rate limiting with Redis
* Protected admin dashboard
* Prometheus metrics endpoint
* Structured logging with Pino
* Kubernetes multi-replica ready
* Graceful shutdown

---

## Quick Start (K3s Lab)

```bash
git clone https://github.com/marcofortina/agegate-as-a-service
cd agegate-as-a-service

kubectl create ns agegate

kubectl apply -f redis.yaml
kubectl apply -f timescaledb.yaml

kubectl create secret generic agegate-secrets \
  --from-literal=ADMIN_PASS=change-me \
  --from-literal=TIMESCALEDB_PASSWORD=change-me \
  -n agegate

helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --values agegate-verifier/values.yaml
```

---

## Documentation

* 📦 Installation guide: `doc/install.md`
* ⚙️ Usage: `doc/usage.md`
* 📡 API: `doc/api.md`

👉 For a detailed step-by-step setup (health checks, troubleshooting, etc.), see **`doc/install.md`**

---

## Configuration

All environment variables are documented in:

```bash
.env.example
```

---

## CI

This project includes a GitHub Actions pipeline:

* Build verifier app
* Run tests (if present)
* Helm chart linting

---

## License

MIT
