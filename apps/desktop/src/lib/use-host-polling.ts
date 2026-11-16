import { useEffect, useState } from "react";

/** Sequential polling: never overlap requests or deliver an old target's response after cleanup. */
export function pollHost<T>(
	load: () => Promise<T>,
	receive: (value: T) => void,
	fail: (error: string) => void,
	intervalMs: number,
): () => void {
	let alive = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const refresh = async () => {
		try {
			const result = await load();
			if (alive) receive(result);
		} catch (error) {
			if (alive) fail(error instanceof Error ? error.message : String(error));
		} finally {
			if (alive) timer = setTimeout(() => void refresh(), intervalMs);
		}
	};
	void refresh();
	return () => {
		alive = false;
		clearTimeout(timer);
	};
}

/** The caller memoizes load for its target. Failed refreshes keep the last successful snapshot. */
export function useHostPolling<T>(load: () => Promise<T>, intervalMs = 3000) {
	const [value, setValue] = useState<T>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		setValue(undefined);
		setError(undefined);
		return pollHost(
			load,
			(result) => {
				setValue(result);
				setError(undefined);
			},
			setError,
			intervalMs,
		);
	}, [load, intervalMs]);
	return { value, error };
}
