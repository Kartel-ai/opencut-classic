type RateLimitRule = {
	window: number;
	max: number;
};

type RateLimitDecision = {
	allowed: boolean;
	retryAfter: number | null;
};

type RedisEvalClient = {
	eval(
		script: string,
		keys: string[],
		args: Array<string | number>,
	): Promise<[number, number]>;
};

export const consumeRateLimitScript = `
local count = redis.call("INCR", KEYS[1])
local window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])

if count == 1 then
  redis.call("EXPIRE", KEYS[1], window)
end

local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], window)
  ttl = window
end

if count <= maximum then
  return { 1, ttl }
end

return { 0, ttl }
`;

export function createRedisRateLimitStorage(redis: RedisEvalClient) {
	return {
		// Better Auth defines this external contract as consume(key, rule).
		// eslint-disable-next-line opencut/prefer-object-params
		consume: async (
			key: string,
			rule: RateLimitRule,
		): Promise<RateLimitDecision> => {
			const [allowedValue, ttlValue] = await redis.eval(
				consumeRateLimitScript,
				[key],
				[rule.window, rule.max],
			);
			const allowed = allowedValue === 1;
			const retryAfter = Math.max(1, Number(ttlValue) || rule.window);
			return {
				allowed,
				retryAfter: allowed ? null : retryAfter,
			};
		},
	};
}
