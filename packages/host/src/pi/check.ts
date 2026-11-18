import type { PiLoader, PiSdk } from "./sdk.ts";

// A 4x4 PNG; the 2x2 limit below forces pi through Photon's decode, resize and encode.
const SAMPLE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8y4AALAxEcQA0BwELeIS5cwAAAABJRU5ErkJggg==";

export interface PiCheck {
	ok: boolean;
	/** The pi that was loaded. */
	pi?: { version: string; packageDir: string };
	error?: string;
}

/**
 * Load the user's pi and resize a sample image through it, as for real attachments: pi drops
 * every image when it cannot load Photon's wasm. `pier-host --check-pi` prints the result.
 */
export async function checkPi(loader: Pick<PiLoader, "load">): Promise<PiCheck> {
	let sdk: PiSdk;
	try {
		sdk = await loader.load();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const pi = { version: sdk.version, packageDir: sdk.packageDir };
	try {
		const bytes = new Uint8Array(Buffer.from(SAMPLE_PNG, "base64"));
		const resized = await sdk.agent.resizeImage(bytes, "image/png", { maxWidth: 2, maxHeight: 2 });
		if (!resized) return { ok: false, pi, error: "pi could not load Photon or resize the image" };
		if (resized.width !== 2 || resized.height !== 2) {
			return { ok: false, pi, error: `unexpected resize result ${resized.width}x${resized.height}` };
		}
		return { ok: true, pi };
	} catch (error) {
		return { ok: false, pi, error: error instanceof Error ? error.message : String(error) };
	}
}
