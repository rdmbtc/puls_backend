-- Protocol stats RPC function — replaces 22-page sequential pagination
-- in /api/stats with a single SQL query. Returns in <500ms.
-- Run this in Supabase Dashboard → SQL Editor.

CREATE OR REPLACE FUNCTION get_protocol_stats()
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'trade_count', COUNT(*),
    'volume_usdc', COALESCE(SUM(usdc_amount), 0),
    'agent_trades', COUNT(*) FILTER (WHERE user_id = 'house_pulse' OR user_id LIKE 'agent_%' OR question LIKE '🤖 Agent:%'),
    'agent_volume', COALESCE(SUM(usdc_amount) FILTER (WHERE user_id = 'house_pulse' OR user_id LIKE 'agent_%' OR question LIKE '🤖 Agent:%'), 0),
    'seed_trades', 0,
    'seed_volume', 0,
    'agent_count', COUNT(DISTINCT user_id) FILTER (WHERE user_id = 'house_pulse' OR user_id LIKE 'agent_%')
  ) INTO result
  FROM trades WHERE state = 'COMPLETE';
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
