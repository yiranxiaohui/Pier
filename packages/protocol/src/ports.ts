/** Listening sockets on the host's computer (1.39), not a firewall reachability scan. */
export interface HostPort {
	protocol: "tcp" | "udp";
	address: string;
	port: number;
	pid?: number;
	process?: string;
}

export interface HostPorts {
	ports: HostPort[];
	truncated: boolean;
}

/** A TCP listener on this computer forwarding to a paired host. */
export interface PortForward {
	id: string;
	peerId: string;
	remoteHost: string;
	remotePort: number;
	localHost: "127.0.0.1";
	localPort: number;
	lastError?: string;
}
