// Read instance UniqueIds out of a Roblox binary place file (.rbxl), enough to name the script containers in a
// Script Sync record the way Studio does. Format per dom.rojo.space/binary: 32-byte header, then chunks of
// [name 4][compressed length u32][uncompressed length u32][reserved 4][data]; a chunk is ZSTD when its data starts
// 28 b5 2f fd, else LZ4 block. INST: class id, class name, object format, count, referents. PROP: class id, property
// name, type id, values; UniqueId is type 0x1f, 16 bytes per value (index u32, time u32, random i64), the array
// byte-interleaved and the ints big-endian, the random field zigzag-transformed like Int64 arrays.
// Text form, as Studio writes it: random (16 hex), time (8), index (8), dashed 8-4-4-4-12. Verified 2026-09-15:
// bb.rbxl's Workspace decodes to the guid Studio used for that place's record slot.
import * as fs from "fs";
import * as zlib from "zlib";

export interface PlaceIds { workspace?: string; byClass: Map<string, string[]> }

const WANT = new Set(["Workspace", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPlayer", "StarterPlayerScripts", "StarterCharacterScripts"]);

export function readPlaceIds(file: string): PlaceIds {
	const data = fs.readFileSync(file);
	if (data.subarray(0, 8).toString("latin1") !== "<roblox!") throw new Error("not a binary place file");
	const classes = new Map<number, { name: string; count: number }>();
	const ids = new Map<string, string[]>();
	let pos = 32;
	while (pos + 16 <= data.length) {
		const name = data.subarray(pos, pos + 4).toString("latin1");
		const comp = data.readUInt32LE(pos + 4), raw = data.readUInt32LE(pos + 8);
		pos += 16;
		const body = decompress(data.subarray(pos, pos + (comp || raw)), raw, comp !== 0);
		pos += comp || raw;
		if (name === "INST") {
			const cid = body.readUInt32LE(0);
			const [cname, p] = str(body, 4);
			classes.set(cid, { name: cname, count: body.readUInt32LE(p + 1) });
		} else if (name === "PROP") {
			const cid = body.readUInt32LE(0);
			const [pname, p] = str(body, 4);
			const cls = classes.get(cid);
			if (pname === "UniqueId" && body[p] === 0x1f && cls && WANT.has(cls.name)) {
				const vals = deinterleave(body.subarray(p + 1, p + 1 + 16 * cls.count), 16, cls.count);
				const list: string[] = [];
				for (let i = 0; i < cls.count; i++) list.push(uidText(vals.readUInt32BE(i * 16), vals.readUInt32BE(i * 16 + 4), vals.readBigUInt64BE(i * 16 + 8)));
				ids.set(cls.name, list);
			}
		} else if (name === "END\0") {
			break;
		}
	}
	return { workspace: ids.get("Workspace")?.[0], byClass: ids };
}

function decompress(chunk: Buffer, rawLength: number, compressed: boolean): Buffer {
	if (!compressed) return chunk;
	if (chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd) {
		const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
		if (!zstd) throw new Error("this place file uses ZSTD chunks and this runtime has no zstd");
		return zstd(chunk);
	}
	return lz4Block(chunk, rawLength);
}

// LZ4 block format: token (literal length high nibble, match length low nibble), extension bytes of 255, literals,
// 2-byte little-endian offset, match extension bytes; the last sequence has literals only.
function lz4Block(src: Buffer, outLength: number): Buffer {
	const out = Buffer.alloc(outLength);
	let i = 0, o = 0;
	while (i < src.length) {
		const token = src[i++];
		let lit = token >> 4;
		if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
		src.copy(out, o, i, i + lit); i += lit; o += lit;
		if (i >= src.length) break;
		const offset = src[i] | (src[i + 1] << 8); i += 2;
		let match = (token & 15) + 4;
		if ((token & 15) === 15) { let b; do { b = src[i++]; match += b; } while (b === 255); }
		let from = o - offset;
		for (let k = 0; k < match; k++) out[o++] = out[from++];   // byte by byte: matches may overlap their own output
	}
	return out;
}

function deinterleave(buf: Buffer, stride: number, count: number): Buffer {
	const out = Buffer.alloc(stride * count);
	for (let i = 0; i < count; i++) for (let b = 0; b < stride; b++) out[i * stride + b] = buf[b * count + i];
	return out;
}

function str(buf: Buffer, pos: number): [string, number] {
	const n = buf.readUInt32LE(pos);
	return [buf.subarray(pos + 4, pos + 4 + n).toString("utf8"), pos + 4 + n];
}

function uidText(index: number, time: number, randomStored: bigint): string {
	const u = BigInt.asUintN(64, randomStored);
	const random = BigInt.asUintN(64, (u >> 1n) ^ (-(u & 1n)));   // undo the zigzag transform
	const hex = random.toString(16).padStart(16, "0") + time.toString(16).padStart(8, "0") + index.toString(16).padStart(8, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
