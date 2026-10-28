export type RendererFailure = { fatal: true; message: string };

export const RENDERER_RECOVERY_MESSAGE =
	"The video renderer stopped. Reopen the editor in Studio to continue. Your edit is still open.";

// A trapped WASM compositor may retain a Rust RefCell borrow. Calling that same
// instance again cannot repair it: preserve the edit and rebuild the frame only
// after Studio has checkpointed its document and exact media.
export function createRendererFailureState() {
	let failure: RendererFailure | null = null;
	const listeners = new Set<() => void>();
	const getSnapshot = () => failure;
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	return {
		getSnapshot,
		subscribe,
		run<T>(action: () => T): T {
			if (failure) throw new Error(RENDERER_RECOVERY_MESSAGE);
			try {
				return action();
			} catch (error) {
				failure = { fatal: true, message: RENDERER_RECOVERY_MESSAGE };
				for (const listener of listeners) listener();
				throw error;
			}
		},
	};
}

export const rendererFailure = createRendererFailureState();
