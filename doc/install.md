# Installation

## Prerequisites

- k3s cluster with Helm 3 and Ingress-nginx
- Redis and TimescaleDB already deployed

## Commands

```bash
cd ~/agegate-as-a-service
helm upgrade --install agegate-verifier ./agegate-verifier --namespace agegate
```

## Verify

```bash
kubectl get pods -n agegate
kubectl get pvc -n agegate
```
