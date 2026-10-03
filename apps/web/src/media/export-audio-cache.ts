// An export owns this cache. Source identity is the immutable File/AudioBuffer
// object (or library URL); trim, gain and retime remain properties of each clip.
// Keep the in-flight promise so cuts of one source never start duplicate decodes.
export function createExportAudioDecodeCache<T>({ concurrency = 2 } = {}) {
	const sources = new Map<object | string, Promise<T>>();
	const waiting: Array<() => void> = [];
	let active = 0;
	const limit = Math.max(1, Math.floor(concurrency));
	return ({
		key,
		decode,
	}: {
		key: object | string;
		decode: () => Promise<T>;
	}): Promise<T> => {
		const cached = sources.get(key);
		if (cached) return cached;
		const result = new Promise<T>((resolve, reject) => {
			const start = () => {
				active++;
				void Promise.resolve()
					.then(decode)
					.then(resolve, reject)
					.finally(() => {
						active--;
						waiting.shift()?.();
					});
			};
			if (active < limit) start();
			else waiting.push(start);
		});
		sources.set(key, result);
		return result;
	};
}
