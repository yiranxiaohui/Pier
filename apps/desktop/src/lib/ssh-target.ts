/** `host`, `user@host`, `host:port` or `user@host:port` typed into the host field. */
export function parseSshTarget(text: string): { host: string; username?: string; port?: number } {
	let rest = text.trim();
	let username: string | undefined;
	const at = rest.lastIndexOf("@");
	if (at > 0) {
		username = rest.slice(0, at);
		rest = rest.slice(at + 1);
	}
	let port: number | undefined;
	const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
	if (bracket) {
		rest = bracket[1] as string;
		if (bracket[2]) port = Number(bracket[2]);
	} else {
		const colon = /^([^:]+):(\d+)$/.exec(rest);
		if (colon) {
			rest = colon[1] as string;
			port = Number(colon[2]);
		}
	}
	return { host: rest, ...(username ? { username } : {}), ...(port ? { port } : {}) };
}
