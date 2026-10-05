import type { ExportFormat } from "./index";

// H.264 (mp4) encoders reject odd widths and heights; mediabunny refuses them
// before asking the browser. A source such as 831x1108 sets an odd canvas, so
// the export rounds each side down to even and the scene fits inside it. The
// saved canvas size is left as it is.
export function encodableExportSize({
	width,
	height,
	format,
}: {
	width: number;
	height: number;
	format: ExportFormat;
}): { width: number; height: number } {
	if (format !== "mp4") return { width, height };
	return { width: evenFloor(width), height: evenFloor(height) };
}

function evenFloor(value: number): number {
	const whole = Math.floor(value);
	return Math.max(2, whole - (whole % 2));
}
