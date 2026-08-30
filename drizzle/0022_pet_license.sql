DO $$ BEGIN
  CREATE TYPE public.pet_license AS ENUM (
    'unspecified',
    'cc0',
    'cc-by',
    'cc-by-sa',
    'cc-by-nc',
    'all-rights-reserved'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.submitted_pets
  ADD COLUMN IF NOT EXISTS license public.pet_license NOT NULL DEFAULT 'unspecified';

ALTER TABLE public.submitted_pets
  ADD COLUMN IF NOT EXISTS license_declared_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS submitted_pets_license_idx
  ON public.submitted_pets (license);
