/** Copying and saving the images shown in chats (attachments and tool results). */

/** An image's decoded pixels: 8-bit RGBA, row by row. */
export interface ImagePixels {
	width: number;
	height: number;
	rgba: Uint8Array;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
	const image = new Image();
	image.src = src;
	await image.decode();
	if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片无法解码");
	return image;
}

/** A canvas holding `src` (a data or blob URL) at its natural size. */
async function drawImage(src: string): Promise<CanvasRenderingContext2D> {
	const image = await loadImage(src);
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("无法创建画布");
	context.drawImage(image, 0, 0);
	return context;
}

/** Decode `src` to RGBA pixels, which the native clipboard takes. */
export async function imagePixels(src: string): Promise<ImagePixels> {
	const context = await drawImage(src);
	const { data, width, height } = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
	return { width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** `src` as a PNG blob, the image type every browser clipboard accepts. */
export async function imagePngBlob(src: string): Promise<Blob> {
	if (src.startsWith("data:image/png")) return (await fetch(src)).blob();
	const { canvas } = await drawImage(src);
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片无法转换为 PNG"))), "image/png"),
	);
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
};

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s;

/** The MIME type and base64 bytes of a base64 `data:` URL, or undefined for any other URL. */
export function parseDataUrl(src: string): { mimeType: string; base64: string } | undefined {
	const match = DATA_URL.exec(src);
	return match?.[1] && match[2] !== undefined ? { mimeType: match[1].toLowerCase(), base64: match[2] } : undefined;
}

/** A file name for saving an image of `mimeType`, stamped with the local time, e.g. `image-20261125-153012.png`. */
export function imageFileName(mimeType: string, now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `image-${stamp}.${EXTENSIONS[mimeType] ?? "png"}`;
}
