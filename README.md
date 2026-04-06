# Age Gate as a Service

Italian anonymous age verification solution based on UE Blueprint (eIDAS 2.0).

**Key Features**

- Fully anonymous age verification (AGCOM double anonymity)
- Multi-threshold support (18 / 21 / 25)
- Distributed rate limiting with Redis
- Protected admin dashboard
- Prometheus metrics endpoint
- Structured logging with Pino
- Kubernetes multi-replica ready
- Graceful shutdown

## Quick Start

```bash
helm upgrade --install agegate-verifier ./agegate-verifier --namespace agegate --create-namespace
```

## Documentation

- doc/install.md
- doc/usage.md
- doc/api.md

License: MIT
