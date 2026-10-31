-- Atomic token bucket: refill, decide, and persist in one step.
-- KEYS[1]  bucket key (hash: tokens, ts)
-- ARGV[1]  capacity B (tokens)
-- ARGV[2]  refill rate r (tokens per second)
-- ARGV[3]  request cost
-- ARGV[4]  optional "now" in ms (tests only); defaults to Redis server time so that
--          gateway replicas never depend on their own clocks.
-- Returns {allowed (0|1), remaining (floor), retryAfterMs, msUntilFull}
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local now
if ARGV[4] and ARGV[4] ~= '' then
  now = tonumber(ARGV[4])
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)

local allowed = 0
local retry_after = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retry_after = math.ceil(((cost - tokens) / rate) * 1000)
end

-- Never move the stored timestamp backwards (clock skew / injected clocks).
redis.call('HSET', KEYS[1], 'tokens', string.format('%.6f', tokens), 'ts', math.max(ts, now))
-- An idle bucket refills completely within capacity/rate seconds; after that it is
-- indistinguishable from a new (full) bucket, so it can safely expire.
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 1000) + 1000)

return { allowed, math.floor(tokens + 1e-9), retry_after, math.ceil(((capacity - tokens) / rate) * 1000) }
