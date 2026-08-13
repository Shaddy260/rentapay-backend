-- Lets a landlord fall back to manual (paybill + admin review) payment
-- when the Daraja STK push fails on "add a property" or "renew a
-- property" - mirrors the existing signup-time manual fallback, but
-- for property_payments rows instead of the landlord's own
-- subscription. See property.controller.js's initiatePropertyPurchase /
-- renewPropertySubscription (stkFailed) and
-- landlordManualSubscriptionPayment.controller.js's confirm handler.

ALTER TABLE landlord_manual_subscription_payments
  ADD COLUMN IF NOT EXISTS property_payment_id uuid REFERENCES property_payments(id);

CREATE INDEX IF NOT EXISTS idx_landlord_manual_sub_payments_property_payment_id
  ON landlord_manual_subscription_payments(property_payment_id);
