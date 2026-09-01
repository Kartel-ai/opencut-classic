import { describe, expect, test } from "bun:test";
import {
	consumeRateLimitScript,
	createRedisRateLimitStorage,
} from "../rate-limit-storage";

describe("createRedisRateLimitStorage", () => {
	test("records an allowed request atomically", async () => {
		const calls: unknown[][] = [];
		const storage = createRedisRateLimitStorage({
			eval: async (...args) => {
				calls.push(args);
				const result: [number, number] = [1, 10];
				return result;
			},
		});

		expect(await storage.consume("auth:user", { window: 10, max: 3 })).toEqual({
			allowed: true,
			retryAfter: null,
		});
		expect(calls).toEqual([[consumeRateLimitScript, ["auth:user"], [10, 3]]]);
	});

	test("returns the authoritative retry interval after the limit", async () => {
		const storage = createRedisRateLimitStorage({
			eval: async () => [0, 7],
		});

		expect(await storage.consume("auth:user", { window: 10, max: 3 })).toEqual({
			allowed: false,
			retryAfter: 7,
		});
	});

	test("repairs a missing Redis expiry inside the same atomic script", () => {
		expect(consumeRateLimitScript).toContain('redis.call("INCR", KEYS[1])');
		expect(consumeRateLimitScript).toContain('redis.call("EXPIRE", KEYS[1], window)');
		expect(consumeRateLimitScript).toContain('redis.call("TTL", KEYS[1])');
	});
});
