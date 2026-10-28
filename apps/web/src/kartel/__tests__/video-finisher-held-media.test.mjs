import test from "node:test";
import assert from "node:assert/strict";
import { HELD_MEDIA_MAX_ITEMS, heldMediaFiles, normalizedHeldMediaRequest } from "../video-finisher-held-media.ts";
import { VIDEO_FINISHER_EDITOR_CAPABILITIES } from "../video-finisher-take-fit.ts";

test("the editor advertises that it can hand back media it holds", () => {
	assert.ok(VIDEO_FINISHER_EDITOR_CAPABILITIES.includes("held-media"));
});

test("a held-media request keeps only well-formed, distinct items and refuses a list that is not one", () => {
	assert.deepEqual(normalizedHeldMediaRequest({ items: [
		{ id: "source-v1", sizeBytes: 12 }, { id: "source-v1", sizeBytes: 12 }, { id: "", sizeBytes: 3 },
		{ id: "voice", sizeBytes: 0 }, { id: "music", sizeBytes: 1.5 }, { id: "x".repeat(241), sizeBytes: 3 }, null, { id: "take", sizeBytes: 4 },
	] }), [{ id: "source-v1", sizeBytes: 12 }, { id: "take", sizeBytes: 4 }]);
	for (const payload of [null, {}, { items: [] }, { items: "source" }, { items: Array.from({ length: HELD_MEDIA_MAX_ITEMS + 1 }, (_, index) => ({ id: `m${index}`, sizeBytes: 1 })) }]) {
		assert.throws(() => normalizedHeldMediaRequest(payload), /invalid list of held media/);
	}
});

test("held files come from the open project, then the store; a different size or a failed read is a miss", async () => {
	const open = new Blob(["0123456789ab"]);
	const stored = new Blob(["take"]);
	const loads = [];
	const held = await heldMediaFiles({
		items: [{ id: "source-v1", sizeBytes: 12 }, { id: "take", sizeBytes: 4 }, { id: "voice", sizeBytes: 9 }, { id: "music", sizeBytes: 5 }, { id: "gone", sizeBytes: 2 }],
		assets: [{ id: "source-v1", file: open }],
		load: async (id) => {
			loads.push(id);
			if (id === "take") return stored;
			if (id === "voice") return new Blob(["short"]);
			if (id === "music") throw new Error("store unavailable");
			return null;
		},
	});
	assert.deepEqual(held.map((item) => item.id), ["source-v1", "take"]);
	assert.equal(held[0].file, open, "the open project's file is handed back as it is, by reference");
	assert.equal(held[1].file, stored);
	assert.deepEqual(loads, ["take", "voice", "music", "gone"], "the store is read only for files the open project lacks");
});
