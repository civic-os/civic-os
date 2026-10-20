-- Verify civic_os:v0-76-7-payment-checkout-translations

DO $$
BEGIN
  IF (SELECT count(*) FROM metadata.translations
      WHERE source_type = 'ui'
        AND source_key IN (
          'payment.complete_payment',
          'payment.summary',
          'payment.amount',
          'payment.processing_fee',
          'payment.total',
          'payment.initializing',
          'payment.initializing_hint',
          'payment.pay_amount',
          'payment.secure_notice',
          'payment.error.not_found',
          'payment.error.already_completed',
          'payment.error.canceled',
          'payment.error.failed',
          'payment.error.timeout',
          'payment.error.load_failed',
          'payment.error.stripe_unavailable',
          'payment.error.init_failed',
          'payment.error.not_initialized',
          'payment.error.declined',
          'payment.error.unexpected',
          'payment.error.verify_failed',
          'payment.error.not_configured',
          'payment.error.initiate_failed'
        )
        AND locale IN ('en', 'es', 'ar', 'fr', 'de', 'ps')) <> 138 THEN
    RAISE EXCEPTION 'Expected 23 payment.* keys x 6 locales (138 rows)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM metadata.translations
    WHERE source_type = 'ui' AND source_key = 'payment.pay_amount' AND locale = 'es'
      AND translated_text = 'Pagar {{amount}}'
  ) THEN
    RAISE EXCEPTION 'Sentinel translation payment.pay_amount/es not found or mismatched';
  END IF;
END $$;
