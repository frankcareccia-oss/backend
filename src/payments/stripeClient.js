// admin/src/payments/stripeClient.js
import { loadStripe } from "@stripe/stripe-js";

const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

if (!pk) {
  // Fail fast in dev so you don't get a blank Elements form
  // Set this in admin/.env:
  // VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
  console.warn("[stripeClient] Missing VITE_STRIPE_PUBLISHABLE_KEY");
}

export const stripePromise = loadStripe(pk);
