import { encode } from "uqr";
import { resultLine, span } from "./cli-render.ts";
import { c, colorLevel, sanitize } from "./cli-style.ts";

interface PairingOutput {
	uri: string;
	expiresAt: string;
}

/**
 * Two QR modules per terminal cell, with a four-module quiet zone on every side.
 * White modules use the foreground: light text on a dark terminal also works without ANSI.
 */
function qrRows(data: boolean[][], ansi: boolean): string[] {
	const rows: string[] = [];
	for (let y = 0; y < data.length; y += 2) {
		let row = "";
		for (let x = 0; x < data.length; x++) {
			const top = data[y]?.[x] ?? false;
			const bottom = data[y + 1]?.[x] ?? false;
			row += top ? (bottom ? " " : "▄") : bottom ? "▀" : "█";
		}
		// Force high contrast on both light and dark themes, without changing later output.
		rows.push(ansi ? `\x1b[0;97;40m${row}\x1b[0m` : row);
	}
	return rows;
}

/** The link always remains intact; never wrap or truncate a QR code to fit a terminal. */
export function pairingRows(pairing: PairingOutput, width: number, interactive: boolean): string[] {
	const until = new Date(pairing.expiresAt).toLocaleTimeString();
	const rows = [
		...resultLine([span("Pairing link "), span(`· valid until ${until} · single use`, c.gray)], width),
		"",
		// Kept on one unwrapped line for copying and for scripts reading piped output.
		c.accent(sanitize(pairing.uri)),
		"",
	];
	let showQr = false;
	if (interactive) {
		try {
			const qr = encode(pairing.uri, { ecc: "M", border: 4 });
			if (qr.size <= width) {
				rows.push(...qrRows(qr.data, colorLevel() > 0), "");
				showQr = true;
			} else {
				rows.push(
					...resultLine(
						`QR code needs ${qr.size + 1} terminal columns. Widen the terminal or reduce the font size, then run /pair again; or paste the link above.`,
						width,
						c.gray,
					),
				);
			}
		} catch {
			// An unusually long URI can exceed QR capacity; pairing by link must still work.
			rows.push(...resultLine("Could not generate a QR code. Use the pairing link above instead.", width, c.gray));
		}
	}
	rows.push(
		...resultLine(
			[
				span(
					showQr
						? "Scan with the Pier mobile app (Add computer), or paste the link above; then confirm here with "
						: "Paste it into the mobile app (Add computer → paste link), then confirm here with ",
					c.gray,
				),
				span("/pair yes", c.accent),
				span(".", c.gray),
			],
			width,
		),
	);
	return rows;
}
