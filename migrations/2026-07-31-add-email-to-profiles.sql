-- Add email column to profiles table for Google OAuth lookup
ALTER TABLE profiles ADD COLUMN email text;
CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles(email);