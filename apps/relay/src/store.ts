/**
 * Persistent state of the relay's admin panel: accounts, their access tokens, login sessions
 * and the settings changed in the panel. Kept in one JSON file (mode 0600) in the data
 * directory; writes go to a temporary file first and are renamed into place.
 *
 * Passwords are stored as scrypt hashes and session tokens only as SHA-256 hashes. Access
 * tokens keep their value so an account can copy them again from the panel at any time.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayMode } from "@pier/crypto";

export type UserRole = "admin" | "user";
/** `pending`: registered and waiting for an administrator; `disabled`: cannot log in. */
export type UserStatus = "active" | "pending" | "disabled";
/** Who may create an account: nobody, anyone after an administrator approves, or anyone. */
export type RegistrationPolicy = "closed" | "approval" | "open";

/** Relay settings that can be changed while it runs. `null` means "the default for the mode". */
export interface RelaySettings {
	mode: RelayMode;
	maxHosts: number | null;
	maxStreamsPerHost: number;
	bytesPerSecond: number | null;
	connectsPerMinute: number;
	publicHost: string | null;
	iceServers: string[];
}

export interface StoredUser {
	id: string;
	username: string;
	/** `scrypt$N$r$p$salt$hash` (base64url). */
	password: string;
	role: UserRole;
	status: UserStatus;
	createdAt: number;
	lastLoginAt?: number;
}

export interface StoredToken {
	id: string;
	userId: string;
	name: string;
	/** SHA-256 of the token (hex). */
	hash: string;
	/** The token itself, so the owner can copy it again (missing for old tokens). */
	secret?: string;
	/** The first characters, to tell tokens apart. */
	hint: string;
	createdAt: number;
	lastUsedAt?: number;
	lastUsedFrom?: string;
}

interface StoredSession {
	/** SHA-256 of the session cookie (hex). */
	hash: string;
	userId: string;
	createdAt: number;
	expiresAt: number;
}

interface StoredData {
	version: 1;
	registration: RegistrationPolicy;
	/** Saved once an administrator changed a setting; overrides the command line from then on. */
	settings?: RelaySettings;
	users: StoredUser[];
	tokens: StoredToken[];
	sessions: StoredSession[];
}

export const DATA_FILE = "pier-relay.json";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TOKENS_PER_USER = 20;
const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 32 };

export class StoreError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newId = () => randomBytes(9).toString("base64url");

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, length: number): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scryptCallback(password.normalize("NFKC"), salt, length, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
			error ? reject(error) : resolve(key),
		),
	);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const { N, r, p, keyLength } = SCRYPT;
	const key = await scrypt(password, salt, N, r, p, keyLength);
	return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [kind, n, r, p, salt, hash] = stored.split("$");
	if (kind !== "scrypt" || !salt || !hash) return false;
	const expected = Buffer.from(hash, "base64url");
	const key = await scrypt(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), expected.length);
	return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to verify against when the account does not exist, so both cases take as long. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
	dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
	return dummyHash;
}

export function validateUsername(username: unknown): string {
	if (typeof username !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(username)) {
		throw new StoreError(400, "用户名需要 3–32 个字符，只能包含字母、数字、下划线、点和连字符，并以字母或数字开头");
	}
	return username;
}

export function validatePassword(password: unknown): string {
	if (typeof password !== "string" || password.length < 8 || password.length > 256) {
		throw new StoreError(400, "密码需要 8–256 个字符");
	}
	return password;
}

/** The owner of an access token that a computer registered with. */
export interface TokenOwner {
	tokenId: string;
	userId: string;
}

export class RelayStore {
	private data: StoredData;
	private readonly tokensByHash = new Map<string, StoredToken>();
	private writing: Promise<void> = Promise.resolve();
	private dirtyTimer: ReturnType<typeof setTimeout> | undefined;

	private constructor(
		readonly file: string,
		data: StoredData,
	) {
		this.data = data;
		this.reindex();
	}

	/** Open (or create) the store in `dir`. */
	static async open(dir: string): Promise<RelayStore> {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const file = join(dir, DATA_FILE);
		let data: StoredData;
		try {
			const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<StoredData>;
			data = {
				version: 1,
				registration: parsed.registration ?? "approval",
				...(parsed.settings ? { settings: parsed.settings } : {}),
				users: parsed.users ?? [],
				tokens: parsed.tokens ?? [],
				sessions: parsed.sessions ?? [],
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
			}
			data = { version: 1, registration: "approval", users: [], tokens: [], sessions: [] };
		}
		const store = new RelayStore(file, data);
		store.pruneSessions();
		// Fail now, not on the first change, when the directory is not writable.
		await store.save();
		return store;
	}

	private reindex(): void {
		this.tokensByHash.clear();
		for (const token of this.data.tokens) this.tokensByHash.set(token.hash, token);
	}

	/** Write the file now (serialized with other writes). */
	save(): Promise<void> {
		if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
		this.dirtyTimer = undefined;
		const snapshot = `${JSON.stringify(this.data, null, "\t")}\n`;
		this.writing = this.writing
			.catch(() => {})
			.then(async () => {
				const temp = `${this.file}.${process.pid}.tmp`;
				await writeFile(temp, snapshot, { mode: 0o600 });
				await chmod(temp, 0o600);
				await rename(temp, this.file);
			});
		return this.writing;
	}

	/** Write soon (for bookkeeping such as "last used"). */
	private saveLater(): void {
		if (this.dirtyTimer) return;
		this.dirtyTimer = setTimeout(() => {
			this.dirtyTimer = undefined;
			void this.save().catch(() => {});
		}, 5000);
		this.dirtyTimer.unref?.();
	}

	/** Write pending changes; call before exiting. */
	async flush(): Promise<void> {
		if (this.dirtyTimer) await this.save();
		await this.writing.catch(() => {});
	}

	// ---- settings -------------------------------------------------------------------------

	get settings(): RelaySettings | undefined {
		return this.data.settings;
	}

	get registration(): RegistrationPolicy {
		return this.data.registration;
	}

	async saveSettings(settings: RelaySettings, registration: RegistrationPolicy): Promise<void> {
		this.data.settings = { ...settings, iceServers: [...settings.iceServers] };
		this.data.registration = registration;
		await this.save();
	}

	// ---- users ----------------------------------------------------------------------------

	get users(): readonly StoredUser[] {
		return this.data.users;
	}

	get hasUsers(): boolean {
		return this.data.users.length > 0;
	}

	user(id: string): StoredUser | undefined {
		return this.data.users.find((u) => u.id === id);
	}

	userByName(username: string): StoredUser | undefined {
		const wanted = username.toLowerCase();
		return this.data.users.find((u) => u.username.toLowerCase() === wanted);
	}

	/**
	 * Register an account. The first account becomes an active administrator whatever the
	 * policy; later ones are refused (`closed`), wait for approval (`approval`) or are active.
	 */
	async registerUser(usernameInput: unknown, passwordInput: unknown, policy: RegistrationPolicy): Promise<StoredUser> {
		const username = validateUsername(usernameInput);
		const password = validatePassword(passwordInput);
		const check = () => {
			if (this.hasUsers && policy === "closed") throw new StoreError(403, "管理员关闭了注册");
			if (this.userByName(username)) throw new StoreError(409, "用户名已被使用");
		};
		check();
		const hash = await hashPassword(password);
		// Decided after hashing, which yields to other requests: only one account can be first.
		check();
		const first = !this.hasUsers;
		const user: StoredUser = {
			id: newId(),
			username,
			password: hash,
			role: first ? "admin" : "user",
			status: first || policy === "open" ? "active" : "pending",
			createdAt: Date.now(),
		};
		this.data.users.push(user);
		await this.save();
		return user;
	}

	async updateUser(id: string, change: { role?: UserRole; status?: UserStatus }): Promise<StoredUser> {
		const user = this.user(id);
		if (!user) throw new StoreError(404, "用户不存在");
		if (change.role) user.role = change.role;
		if (change.status) user.status = change.status;
		if (user.status !== "active") this.dropSessions(id);
		await this.save();
		return user;
	}

	async setPassword(id: string, passwordInput: unknown, keepSession?: string): Promise<void> {
		const user = this.user(id);
		if (!user) throw new StoreError(404, "用户不存在");
		user.password = await hashPassword(validatePassword(passwordInput));
		this.dropSessions(id, keepSession);
		await this.save();
	}

	async deleteUser(id: string): Promise<void> {
		const index = this.data.users.findIndex((u) => u.id === id);
		if (index < 0) throw new StoreError(404, "用户不存在");
		this.data.users.splice(index, 1);
		this.data.tokens = this.data.tokens.filter((t) => t.userId !== id);
		this.reindex();
		this.dropSessions(id);
		await this.save();
	}

	async recordLogin(user: StoredUser): Promise<void> {
		user.lastLoginAt = Date.now();
		this.saveLater();
	}

	// ---- access tokens --------------------------------------------------------------------

	tokensOf(userId: string): StoredToken[] {
		return this.data.tokens.filter((t) => t.userId === userId);
	}

	token(id: string): StoredToken | undefined {
		return this.data.tokens.find((t) => t.id === id);
	}

	/** Create an access token; the owner can read its value again later. */
	async createToken(userId: string, nameInput: unknown): Promise<{ token: string; item: StoredToken }> {
		const name = typeof nameInput === "string" ? nameInput.trim() : "";
		if (!name || name.length > 40) throw new StoreError(400, "令牌名称需要 1–40 个字符");
		if (this.tokensOf(userId).length >= MAX_TOKENS_PER_USER) {
			throw new StoreError(400, `每个账号最多 ${MAX_TOKENS_PER_USER} 个令牌，请先删除不用的令牌`);
		}
		const token = `prt_${randomBytes(24).toString("base64url")}`;
		const item: StoredToken = {
			id: newId(),
			userId,
			name,
			hash: sha256(token),
			secret: token,
			hint: token.slice(0, 8),
			createdAt: Date.now(),
		};
		this.data.tokens.push(item);
		this.tokensByHash.set(item.hash, item);
		await this.save();
		return { token, item };
	}

	async deleteToken(id: string): Promise<void> {
		const index = this.data.tokens.findIndex((t) => t.id === id);
		if (index < 0) throw new StoreError(404, "令牌不存在");
		this.data.tokens.splice(index, 1);
		this.reindex();
		await this.save();
	}

	/** The account token `token` belongs to, if it is valid and its owner is active. */
	resolveToken(token: string, from?: string): TokenOwner | undefined {
		if (!token.startsWith("prt_")) return undefined;
		const item = this.tokensByHash.get(sha256(token));
		if (!item || !this.tokenValid(item.id)) return undefined;
		item.lastUsedAt = Date.now();
		if (from) item.lastUsedFrom = from;
		this.saveLater();
		return { tokenId: item.id, userId: item.userId };
	}

	/** Whether the token still exists and belongs to an active account. */
	tokenValid(tokenId: string): boolean {
		const item = this.data.tokens.find((t) => t.id === tokenId);
		return !!item && this.user(item.userId)?.status === "active";
	}

	// ---- sessions -------------------------------------------------------------------------

	async createSession(userId: string): Promise<string> {
		const token = randomBytes(32).toString("base64url");
		const now = Date.now();
		this.data.sessions.push({ hash: sha256(token), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
		await this.save();
		return token;
	}

	/** The active user a session cookie belongs to. */
	sessionUser(token: string | undefined): StoredUser | undefined {
		if (!token) return undefined;
		const hash = sha256(token);
		const session = this.data.sessions.find((s) => s.hash === hash);
		if (!session) return undefined;
		if (session.expiresAt <= Date.now()) {
			this.pruneSessions();
			this.saveLater();
			return undefined;
		}
		const user = this.user(session.userId);
		return user?.status === "active" ? user : undefined;
	}

	async deleteSession(token: string): Promise<void> {
		const hash = sha256(token);
		this.data.sessions = this.data.sessions.filter((s) => s.hash !== hash);
		await this.save();
	}

	private dropSessions(userId: string, keep?: string): void {
		const kept = keep ? sha256(keep) : undefined;
		this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId || s.hash === kept);
	}

	private pruneSessions(): void {
		const now = Date.now();
		this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
	}
}
