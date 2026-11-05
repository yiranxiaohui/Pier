/**
 * Work that must finish before `pier cli` exits. The single-file `pier` registers one when it
 * started a Host just for this terminal, so quitting the CLI stops that Host first.
 */
const hooks: Array<() => Promise<void>> = [];
let exiting: Promise<never> | undefined;

/** Run `hook` before the CLI exits. */
export function beforeCliExit(hook: () => Promise<void>): void {
	hooks.push(hook);
}

/** Run the registered hooks once (a failing hook does not keep the others from running), then exit. */
export function exitCli(code: number): Promise<never> {
	exiting ??= (async () => {
		for (const hook of hooks.splice(0)) await hook().catch(() => undefined);
		process.exit(code);
	})();
	return exiting;
}
