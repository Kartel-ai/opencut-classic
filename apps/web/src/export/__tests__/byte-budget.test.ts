import { expect, test } from "bun:test";
import { createExportByteBudget } from "../byte-budget";

test("encoded bytes stop a long export after the crossing packet, before the remaining frames", () => {
	const budget = createExportByteBudget(100);
	let frames = 0;
	expect(() => {
		for (; frames < 240; frames++) {
			budget.addPacket(30);
			budget.check();
		}
	}).toThrow("recovery limit");
	expect(frames).toBe(3);
});

test("rewritten MP4 headers use high-water size, and container overhead cannot bypass the cap", () => {
	const budget = createExportByteBudget(100);
	budget.addPacket(80);
	budget.writeThrough(100);
	budget.check();
	budget.writeThrough(20);
	budget.check();
	budget.writeThrough(101);
	expect(() => budget.check()).toThrow("recovery limit");
});
