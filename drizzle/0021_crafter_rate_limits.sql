CREATE TABLE IF NOT EXISTS public.crafter_rate_limits (
  key text PRIMARY KEY,
  count bigint NOT NULL,
  window_started_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS crafter_rate_limits_expires_at_idx
  ON public.crafter_rate_limits (expires_at);
