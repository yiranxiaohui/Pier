/**
 * Set when this process is the Linux single-file Pier (`runStandalone`): that one file can be
 * copied to another Linux computer of the same architecture and run there as is.
 */
export const standaloneExecutable: {
	path?: string;
	version?: string;
	/** Installed with `pier install` (updated by `pier update`), not run as a portable copy. */
	installed?: boolean;
} = {};
