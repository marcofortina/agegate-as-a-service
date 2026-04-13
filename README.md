[![CI](https://github.com/marcofortina/agegate-as-a-service/actions/workflows/ci.yml/badge.svg)](https://github.com/marcofortina/agegate-as-a-service/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Landing Page](https://img.shields.io/badge/🌐-Landing%20Page-brightgreen)](https://agegate.local/)
[![Pricing](https://img.shields.io/badge/💰-Pricing-blue)](https://agegate.local/pricing)
[![codecov](https://codecov.io/github/marcofortina/agegate-as-a-service/graph/badge.svg?token=YP4U4MW6J2)](https://codecov.io/github/marcofortina/agegate-as-a-service)

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

For detailed guides, see:
- [Installation](./doc/install.md)
- [API Reference](./doc/api.md)
- [Privacy & Double Anonymity](./doc/privacy.md)
- [Integration Example](./doc/integration-example.md)
- [Backup & Restore](./doc/backup-restore.md)
- [Upgrading Helm Chart](./doc/upgrade-helm.md)

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
  --set secrets.TIMESCALEDB_PASSWORD=YOUR_DB_PASSWORD \
  --set secrets.ADMIN_PASS=YOUR_ADMIN_PASSWORD
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
