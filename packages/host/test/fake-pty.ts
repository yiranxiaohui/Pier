/** A stand-in for Bun's pseudo-terminals, for `PtyTerminals` under Node. */
import { IXON, type PtyChild, type PtySpawnOptions, type SpawnPty } from "../src/pty-terminals.ts";

export interface FakePtyChild extends PtyChild {
	readonly options: PtySpawnOptions;
	readonly writes: (string | Uint8Array)[];
	readonly sizes: [number, number][];
	readonly signals: string[];
	closed: boolean;
	/** The terminal's `c_iflag` (XON / XOFF on by default). */
	flags: number;
	/** End the program with this exit code. */
	finish(code: number | null): void;
}

export function fakePtySpawn(): { spawn: SpawnPty; children: FakePtyChild[] } {
	const children: FakePtyChild[] = [];
	const spawn = (options: PtySpawnOptions): PtyChild => {
		let finish!: (code: number | null) => void;
		const exited = new Promise<number | null>((resolve) => {
			finish = resolve;
		});
		const child: FakePtyChild = {
			options,
			writes: [],
			sizes: [],
			signals: [],
			closed: false,
			flags: IXON,
			exited,
			finish,
			get inputFlags() {
				return child.closed ? 0 : child.flags;
			},
			write: (data) => {
				child.writes.push(data);
			},
			resize: (cols, rows) => {
				child.sizes.push([cols, rows]);
			},
			signal: (signal) => {
				child.signals.push(signal);
			},
			close: () => {
				child.closed = true;
			},
		};
		children.push(child);
		return child;
	};
	return { spawn, children };
}
