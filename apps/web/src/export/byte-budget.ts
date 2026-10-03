// Packet bytes give an early lower bound while an in-memory MP4 muxer retains
// samples. Target write ends additionally enforce the exact container size.
export function createExportByteBudget(maxBytes?: number) {
	if (
		maxBytes !== undefined &&
		(!Number.isSafeInteger(maxBytes) || maxBytes < 1)
	) {
		throw new Error("The export byte limit is invalid.");
	}
	let packetBytes = 0;
	let writtenBytes = 0;
	return {
		addPacket(bytes: number) {
			packetBytes += bytes;
		},
		writeThrough(end: number) {
			writtenBytes = Math.max(writtenBytes, end);
		},
		check() {
			if (
				maxBytes !== undefined &&
				Math.max(packetBytes, writtenBytes) > maxBytes
			) {
				throw new Error(
					`The exported MP4 exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB recovery limit. Shorten the timeline before exporting again. The project remains saved.`,
				);
			}
		},
	};
}
