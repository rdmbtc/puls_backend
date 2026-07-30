-- Add email column to profiles table for Google OAuth lookup
ALTER TABLE IF NOT EXISTS profiles ADD COLUMN IF NOT EXISTS email text;
CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles(email);