# Stripe Integration for Subscription Billing

Age Gate as a Service supports subscription plans (Free, Pro, Enterprise) using Stripe. Customers can upgrade from the client dashboard.

## Configuration

Set the following environment variables:

```bash
STRIPE_SECRET_KEY=sk_live_...        # your Stripe secret key
STRIPE_WEBHOOK_SECRET=whsec_...      # webhook signing secret
STRIPE_PRICE_PRO_MONTHLY=price_...   # price ID for the Pro monthly plan
```

The Free and Enterprise plans do not require a Stripe price ID (they are managed internally).

## Webhook Endpoint

Configure a webhook in your Stripe dashboard pointing to:
```
https://your-domain.com/api/v1/stripe/webhook
```
Select events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.

## Customer Portal

Once subscribed, customers can manage their billing via the Stripe Customer Portal link shown in the client dashboard.

## Local Testing

Use Stripe CLI to forward webhooks to your local server:
```bash
stripe listen --forward-to localhost:8080/api/v1/stripe/webhook
```

## Plans

| Plan | Rate limit (req/min) | Daily limit | Monthly price |
|------|----------------------|-------------|----------------|
| Free | 100                  | 1,000       | €0             |
| Pro  | 1,000                | 10,000      | €49            |
| Enterprise | 10,000         | 100,000     | Custom         |

## API Endpoints

- `GET /api/v1/plans` – list available plans
- `GET /api/v1/client/subscription` – current subscription status (requires `x-api-key`)
- `POST /api/v1/stripe/create-checkout-session` – create a checkout session (requires `x-api-key`)
