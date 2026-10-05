import { expect, test } from "bun:test";
import { encodableExportSize } from "../encodable-size";

test("mp4 export rounds odd canvas sides down to even", () => {
	expect(encodableExportSize({ width: 831, height: 1108, format: "mp4" })).toEqual({ width: 830, height: 1108 });
	expect(encodableExportSize({ width: 1281, height: 721, format: "mp4" })).toEqual({ width: 1280, height: 720 });
	expect(encodableExportSize({ width: 1280, height: 720, format: "mp4" })).toEqual({ width: 1280, height: 720 });
	expect(encodableExportSize({ width: 1, height: 1, format: "mp4" })).toEqual({ width: 2, height: 2 });
});

test("webm export keeps the canvas size", () => {
	expect(encodableExportSize({ width: 831, height: 1107, format: "webm" })).toEqual({ width: 831, height: 1107 });
});
