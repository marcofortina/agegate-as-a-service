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

### Privacy First
* **Double anonymity** via IP hashing (SHA256 + daily salt rotation)
* No IP addresses stored in logs or database
* Compliant with EU Blueprint and AGCOM requirements

---

## Quick Start (K3s Lab)

```bash
git clone https://github.com/marcofortina/agegate-as-a-service
cd agegate-as-a-service

helm upgrade --install agegate-verifier ./agegate-verifier \
  --namespace agegate \
  --create-namespace \
  --values agegate-verifier/values.yaml \
  --set env.TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD \
  --set env.ADMIN_PASS=YOUR_ADMIN_PASSWORD
```

---

## Documentation

* 📦 Installation guide: `doc/install.md`
* ⚙️ Usage: `doc/usage.md`
* 📡 API: `doc/api.md`

👉 For a detailed step-by-step setup (health checks, troubleshooting, etc.), see **`doc/install.md`**

---

## Development

See [doc/development.md](doc/development.md) for full setup, linting, testing, and K3s lab workflow.
(Includes notes on secrets, passwords, and CI/CD workflow.)

---

## Configuration

All environment variables are documented in:

```bash
.env.example
```

### Privacy Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANONYMIZE_IP` | `true` | Enable IP hashing (double anonymity) |
| `IP_SALT` | auto-generated | Secret salt for IP hashing (rotate daily) |

---

## CI

This project includes a GitHub Actions pipeline:

* Build verifier app
* Run tests (if present)
* Helm chart linting

---

## License

MIT
