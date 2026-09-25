/**
 * pi-inline-images
 *
 * 把消息里的直链标记（如 `[png:https://img.raykari.com/i/xxx.png]`）下载到本地
 * 插件数据目录，并就地转换：
 *
 *   - 图片（png/jpg/jpeg/gif/webp/bmp/avif/svg/img/image）
 *       → 预压缩（复用 pi 内置 processImage，与 read 工具贴图同款策略）
 *       → 文本里替换成 `[img:<本地路径>]` 引用
 *       → 发模型前由 `context` 钩子展开成多模态图片块（随本次请求，省掉模型
 *         自己下载/read 的一轮工具调用）
 *
 *   - 其他文件（srt/mp3/mp4/txt/zip/… 任意 `[类型:直链]`）
 *       → 原样下载存盘
 *       → 文本里替换成 `<本地路径>`，模型按需用 read/bash 工具处理
 *
 * 设计取舍：
 *   - 会话记录里只存【路径引用】，不存 base64 —— 会话文件保持轻量、信息不丢
 *     （原文件永远留在数据目录）；
 *   - 多模态图片块只在【请求本地】注入（context 钩子），可重复、幂等、不落盘；
 *   - 预压缩一次、双级缓存（内存 + 磁盘），后续请求零下载零压缩零拷贝。
 *
 * 一条消息里可混排任意多个标记（多图 / 图+文件 / 图+音频…），全部并发下载、
 * 按出现顺序就地替换；下载失败的标记原样保留（模型可自行抓取兜底）。
 *
 * 数据目录：~/.pi/agent/pi-inline-images/  （PI_INLINE_IMAGES_DIR 可覆盖）
 *   <hash>.<ext>          原文件（按 URL 去重，永不覆盖）
 *   <hash>.meta.json      来源 URL / 类型 / 大小 / 时间
 *   <hash>.inline.json    预压缩结果（发给模型的 base64，二级缓存）
 *
 * 环境变量（均可选）：
 *   PI_INLINE_IMAGES_DIR               数据目录
 *   PI_INLINE_IMAGES_MAX_MB            单文件大小上限（默认 20）
 *   PI_INLINE_IMAGES_TIMEOUT_MS        下载超时（默认 20000）
 *   PI_INLINE_IMAGES_MAX_PER_MESSAGE   单条消息最多处理标记数（默认 24）
 *   PI_INLINE_IMAGES_MAX_W             图片压缩目标最大宽（默认 1536）
 *   PI_INLINE_IMAGES_MAX_H             图片压缩目标最大高（默认 1536）
 *   PI_INLINE_IMAGES_JPEG_Q            压缩 JPEG 质量（默认 75）
 *   PI_INLINE_IMAGES_INLINE_MAX_KB     压缩后 base64 上限（默认 1200 KB）
 *   PI_INLINE_IMAGES_NO_COMPRESS       置 1 关闭预压缩
 *   PI_INLINE_IMAGES_USER_AGENT        下载 UA
 *
 * 命令：`/inline-images` 查看统计与配置。
 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------- 配置

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_BYTES = Math.floor(envNumber("PI_INLINE_IMAGES_MAX_MB", 20) * 1024 * 1024);
const TIMEOUT_MS = envNumber("PI_INLINE_IMAGES_TIMEOUT_MS", 20_000);
const MAX_PER_MESSAGE = envNumber("PI_INLINE_IMAGES_MAX_PER_MESSAGE", 24);
const RESIZE_MAX_W = envNumber("PI_INLINE_IMAGES_MAX_W", 1536);
const RESIZE_MAX_H = envNumber("PI_INLINE_IMAGES_MAX_H", 1536);
const RESIZE_JPEG_Q = envNumber("PI_INLINE_IMAGES_JPEG_Q", 75);
const RESIZE_MAX_B64_BYTES = Math.floor(envNumber("PI_INLINE_IMAGES_INLINE_MAX_KB", 1200) * 1024);
const NO_COMPRESS = process.env.PI_INLINE_IMAGES_NO_COMPRESS === "1";
/** 压缩参数指纹：参数变化后缓存自动失效并重新压缩（避免新旧压缩结果混用） */
const COMPRESS_PROFILE = `${RESIZE_MAX_W}x${RESIZE_MAX_H}/q${RESIZE_JPEG_Q}/${RESIZE_MAX_B64_BYTES}${NO_COMPRESS ? "/raw" : ""}`;
const USER_AGENT =
	process.env.PI_INLINE_IMAGES_USER_AGENT ??
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** 会话记录里的图片引用标记；context 钩子展开为多模态图片块 */
const REF_PREFIX = "img";

function defaultDataDir(): string {
	return process.env.PI_INLINE_IMAGES_DIR || join(homedir(), ".pi", "agent", "pi-inline-images");
}

let DATA_DIR = defaultDataDir();

/** 测试用：切换数据目录 */
export function setDataDir(dir: string): void {
	DATA_DIR = dir;
}

// ---------------------------------------------------------------- 标记解析

/** [png:https://…] / [srt:https://…] / [file:https://…] … 任意 1-10 位类型 + http(s) 直链 */
const MARKER_RE = /\[(?<kind>[a-z0-9]{1,10}):(?<url>https?:\/\/[^\]\s]+)\]/gi;
const MARKER_QUICK_RE = /\[[a-z0-9]{1,10}:https?:\/\//i;
/** 本地图片引用 [img:/abs/path.png]（展开为多模态图片块） */
const REF_RE = /\[img:(?!https?:\/\/)(?<path>[^\]\r\n]+)\]/gi;
const REF_QUICK_RE = /\[img:(?!https?:\/\/)/i;

const IMAGE_KINDS = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "avif", "svg", "img", "image"]);

export interface MarkerSegment {
	type: "marker";
	kind: string;
	url: string;
	raw: string;
	isImage: boolean;
}
export type Segment = { type: "text"; text: string } | MarkerSegment;
export type RefSegment = { type: "text"; text: string } | { type: "ref"; path: string; raw: string };

export function hasMarker(text: string): boolean {
	return MARKER_QUICK_RE.test(text);
}

export function hasRef(text: string): boolean {
	return REF_QUICK_RE.test(text);
}

/** 需要 context 展开的快速判断 */
export function hasInlineable(text: string): boolean {
	return MARKER_QUICK_RE.test(text) || REF_QUICK_RE.test(text);
}

export function splitSegments(text: string): Segment[] {
	const segments: Segment[] = [];
	let last = 0;
	MARKER_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MARKER_RE.exec(text)) !== null) {
		if (m.index > last) segments.push({ type: "text", text: text.slice(last, m.index) });
		const kind = m.groups!.kind!.toLowerCase();
		segments.push({ type: "marker", kind, url: m.groups!.url!, raw: m[0], isImage: IMAGE_KINDS.has(kind) });
		last = m.index + m[0].length;
	}
	if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
	return segments;
}

export function splitRefs(text: string): RefSegment[] {
	const segments: RefSegment[] = [];
	let last = 0;
	REF_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = REF_RE.exec(text)) !== null) {
		if (m.index > last) segments.push({ type: "text", text: text.slice(last, m.index) });
		segments.push({ type: "ref", path: m.groups!.path!.trim(), raw: m[0] });
		last = m.index + m[0].length;
	}
	if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
	return segments;
}

// ---------------------------------------------------------------- MIME 推断

const EXT_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jfif: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	svg: "image/svg+xml",
};
const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
};

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
	if (bytes.length < offset + sig.length) return false;
	for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
	return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset + offset, Math.max(0, Math.min(length, bytes.length - offset))).toString(
		"latin1",
	);
}

/** 按魔数嗅探图片类型，嗅探不出返回 undefined */
export function sniffMime(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
	if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
	if (ascii(bytes, 4, 4) === "ftyp") {
		const brand = ascii(bytes, 8, 4);
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") return "image/heic";
	}
	const head = ascii(bytes, 0, 512).trimStart().toLowerCase();
	if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
	return undefined;
}

function mimeFromContentType(header: string | null): string | undefined {
	if (!header) return undefined;
	const mime = header.split(";")[0].trim().toLowerCase();
	return mime.startsWith("image/") ? mime : undefined;
}

function extFromHint(kind: string, url: string): string | undefined {
	if (kind !== "img" && kind !== "image" && kind !== "file" && /^[a-z0-9]{1,10}$/.test(kind)) return kind;
	const path = url.split(/[?#]/)[0];
	const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
	return /^[a-z0-9]{1,10}$/.test(ext) ? ext : undefined;
}

/**
 * 确定性文件后缀（不依赖下载结果，保证【文本替换】与【实际落盘】路径一致）：
 * URL 后缀优先 → 标记类型（jpeg/jfif 归一为 jpg）→ bin。
 */
function deterministicExt(kind: string, url: string): string {
	const path = url.split(/[?#]/)[0];
	const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
	if (/^[a-z0-9]{1,10}$/.test(ext)) return ext;
	if (kind === "jpeg" || kind === "jfif") return "jpg";
	if (kind !== "img" && kind !== "image" && kind !== "file" && /^[a-z0-9]{1,10}$/.test(kind)) return kind;
	return "bin";
}

/** 直链 → 本地落盘路径（确定性，可在下载完成前就写进文本） */
function localPathFor(url: string, kind: string): string {
	return join(DATA_DIR, `${shortHash(url)}.${deterministicExt(kind, url)}`);
}

// ---------------------------------------------------------------- 预压缩（复用 pi 内置 processImage）

type ProcessImageFn = (
	bytes: Uint8Array,
	mimeType: string,
	options?: {
		autoResizeImages?: boolean;
		resizeOptions?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number };
	},
) => Promise<{ ok: true; data: string; mimeType: string; hints: string[] } | { ok: false; message: string }>;

let processImagePromise: Promise<ProcessImageFn | null> | null = null;

/** 从 pi 进程入口启发式定位内置图片处理模块（read 工具贴图同款） */
function loadProcessImage(): Promise<ProcessImageFn | null> {
	if (processImagePromise) return processImagePromise;
	processImagePromise = (async () => {
		try {
			const forced = process.env.PI_INLINE_IMAGES_PI_DIST;
			const candidates: string[] = [];
			if (forced) {
				candidates.push(join(forced, "utils", "image-process.js"), join(forced, "dist", "utils", "image-process.js"), forced);
			}
			const req = createRequire(import.meta.url);
			let entry = "";
			try {
				entry = realpathSync(process.argv[1]);
			} catch {
				try {
					entry = realpathSync(req.resolve("@earendil-works/pi-coding-agent"));
				} catch {
					// 继续用 candidates
				}
			}
			let dir = entry ? dirname(entry) : "";
			for (let i = 0; i < 8 && dir; i++) {
				candidates.push(join(dir, "utils", "image-process.js"), join(dir, "dist", "utils", "image-process.js"));
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
			let found: string | null = null;
			for (const cand of candidates) {
				if (existsSync(cand)) {
					found = cand;
					break;
				}
			}
			if (!found) return null;
			const mod = (await import(found)) as { processImage?: ProcessImageFn };
			return typeof mod.processImage === "function" ? mod.processImage : null;
		} catch {
			return null;
		}
	})();
	return processImagePromise;
}

/** 预压缩：返回可直接发给模型的 ImageContent（含 base64） */
export async function compressImage(bytes: Uint8Array, mimeType: string): Promise<ImageContent> {
	if (NO_COMPRESS) return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
	const processImage = await loadProcessImage();
	if (!processImage) return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
	const r = await processImage(bytes, mimeType, {
		autoResizeImages: true,
		resizeOptions: {
			maxWidth: RESIZE_MAX_W,
			maxHeight: RESIZE_MAX_H,
			maxBytes: RESIZE_MAX_B64_BYTES,
			jpegQuality: RESIZE_JPEG_Q,
		},
	});
	if (r.ok) return { type: "image", data: r.data, mimeType: r.mimeType };
	// 压不动就发原图，保证信息不丢
	return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
}

// ---------------------------------------------------------------- 数据目录 / 缓存

interface MetaFile {
	url: string;
	kind: string;
	ext: string;
	mimeType?: string;
	bytes: number;
	savedAt: string;
}

export interface AcquireResult {
	ok: boolean;
	/** 本地绝对路径 */
	path?: string;
	isImage: boolean;
	mimeType?: string;
	bytes?: number;
	fromCache?: boolean;
	error?: string;
}

function shortHash(url: string): string {
	// FNV-1a 64bit → hex（无需加密强度，仅做文件名去重）
	let h1 = 0xcbf29ce4n;
	let h2 = 0x84222325n;
	for (let i = 0; i < url.length; i++) {
		const c = BigInt(url.charCodeAt(i));
		h1 = ((h1 ^ c) * 0x100000001b3n) & 0xffffffffffffffffn;
		h2 = ((h2 ^ (c + 7n)) * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).slice(0, 24);
}

function ensureDataDir(): void {
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** 原子写入：先写 .part 再 rename，任何时刻读到的文件要么不存在、要么完整 */
function writeBytesAtomic(path: string, bytes: Uint8Array): void {
	const tmp = `${path}.part`;
	writeFileSync(tmp, bytes);
	try {
		renameSync(tmp, path);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// 忽略
		}
		throw err;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	writeBytesAtomic(path, Buffer.from(JSON.stringify(value), "utf8"));
}

function metaPath(hash: string): string {
	return join(DATA_DIR, `${hash}.meta.json`);
}

function inlineCachePath(hash: string): string {
	return join(DATA_DIR, `${hash}.inline.json`);
}

function hashFromLocalPath(path: string): string {
	return basename(path).split(".")[0];
}

/**
 * 源文件指纹（大小+mtime）：同路径文件被改写后缓存自动失效。
 * 这保证同一引用在每次请求里展开出的 base64 逐字节一致，
 * provider 侧 prompt cache 前缀不被意外打断。
 */
function sourceFingerprint(path: string): string | null {
	try {
		const st = statSync(path);
		return `${st.size}:${Math.floor(st.mtimeMs)}`;
	} catch {
		return null;
	}
}

// URL → 结果：并发去重 + 会话内免重复访问磁盘
const acquireCache = new Map<string, Promise<AcquireResult>>();
// 本地图片路径 → 压缩后的多模态块（内存一级缓存，引用复用零拷贝；带指纹校验）
const inlineCache = new Map<string, { source: string; profile: string; image: ImageContent }>();
// 近期下载失败：本地路径 → 失败信息（节流：60s 内不重复请求同一个失败链接）
const failureByPath = new Map<string, { url: string; error: string; until: number }>();
const FAIL_RETRY_MS = 60_000;

export function clearCaches(): void {
	acquireCache.clear();
	inlineCache.clear();
	failureByPath.clear();
}

/**
 * 启动（或复用）一个直链下载，立即返回确定性路径。
 * 调用方 await 返回的 promise 即可保证文件完整落盘。
 */
export function startFile(url: string, kind: string): { path: string; promise: Promise<AcquireResult> } {
	const path = localPathFor(url, kind);
	const cached = acquireCache.get(url);
	if (cached) return { path, promise: cached };

	const failure = failureByPath.get(path);
	if (failure && failure.until > Date.now()) {
		// 近期失败过：不重复请求，快速返回失败
		return {
			path,
			promise: Promise.resolve({ ok: false, isImage: IMAGE_KINDS.has(kind), error: failure.error }),
		};
	}

	const promise = acquireFile(url, kind);
	promise.then((r) => {
		if (r.ok) failureByPath.delete(path);
		else {
			stats.failed++;
			failureByPath.set(path, { url, error: r.error ?? "未知错误", until: Date.now() + FAIL_RETRY_MS });
		}
	});
	return { path, promise };
}
/** 下载（或复用已存盘文件）一个直链到数据目录 */
export async function acquireFile(url: string, kind: string): Promise<AcquireResult> {
	const cached = acquireCache.get(url);
	if (cached) return cached;
	const pending = acquireFileUncached(url, kind);
	acquireCache.set(url, pending);
	pending.then((r) => {
		if (!r.ok) acquireCache.delete(url); // 失败不缓存，便于重试
	});
	return pending;
}

async function acquireFileUncached(url: string, kind: string): Promise<AcquireResult> {
	const isImage = IMAGE_KINDS.has(kind);
	const hash = shortHash(url);

	// 1) 磁盘命中：已存过盘的文件直接复用（不重新下载）
	ensureDataDir();
	const path = localPathFor(url, kind);
	try {
		const metaRaw = readFileSync(metaPath(hash), "utf8");
		const meta = JSON.parse(metaRaw) as MetaFile;
		if (meta && meta.url === url && existsSync(path)) {
			stats.cacheHits++;
			return { ok: true, path, isImage, mimeType: meta.mimeType, bytes: meta.bytes, fromCache: true };
		}
	} catch {
		// 无缓存，走下载
	}

	// 2) 下载
	let res: Response;
	try {
		res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { "user-agent": USER_AGENT, accept: "*/*" },
		});
	} catch (err) {
		return { ok: false, isImage, error: `下载失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!res.ok) return { ok: false, isImage, error: `下载失败: HTTP ${res.status}` };

	const declared = Number(res.headers.get("content-length") ?? "0");
	if (declared > MAX_BYTES) {
		return { ok: false, isImage, error: `文件过大: ${formatBytes(declared)} > ${formatBytes(MAX_BYTES)}` };
	}
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch (err) {
		return { ok: false, isImage, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (bytes.byteLength > MAX_BYTES) {
		return { ok: false, isImage, error: `文件过大: ${formatBytes(bytes.byteLength)} > ${formatBytes(MAX_BYTES)}` };
	}
	if (bytes.byteLength === 0) return { ok: false, isImage, error: "下载失败: 空响应" };

	// 3) 落盘（原文件保真保存，会话不丢信息；路径确定性，与文本替换一致）
	const sniffed = sniffMime(bytes);
	const mime = sniffed ?? mimeFromContentType(res.headers.get("content-type"));
	const ext = deterministicExt(kind, url);
	try {
		writeBytesAtomic(path, bytes);
		writeJsonAtomic(
			metaPath(hash),
			{ url, kind, ext, mimeType: mime, bytes: bytes.byteLength, savedAt: new Date().toISOString() } satisfies MetaFile,
		);
	} catch (err) {
		return { ok: false, isImage, error: `保存失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	stats.filesSaved++;
	stats.bytesDownloaded += bytes.byteLength;

	// 4) 图片顺手预压缩（一次），结果写二级缓存（含指纹，保证每次请求内容一致）
	if (isImage && mime) {
		try {
			const inline = await compressImage(bytes, mime);
			const source = sourceFingerprint(path) ?? `${bytes.byteLength}:0`;
			inlineCache.set(path, { source, profile: COMPRESS_PROFILE, image: inline });
			writeJsonAtomic(inlineCachePath(hash), {
				mimeType: inline.mimeType,
				data: inline.data,
				profile: COMPRESS_PROFILE,
				source,
			});
			stats.bytesInline += Math.floor((inline.data.length * 3) / 4);
		} catch {
			// 压缩失败不致命：注入时会再试或退回原图
		}
	}

	return { ok: true, path, isImage, mimeType: mime, bytes: bytes.byteLength };
}

/**
 * 取本地图片的多模态块（内存 → 磁盘二级缓存 → 读原图压缩一次）。
 * 缓存带【来源指纹 + 压缩参数指纹】：只有源文件和参数都没变才复用，
 * 保证同一引用在历次请求中展开出的 base64 逐字节一致（prompt cache 不断）。
 */
export async function getInlineImage(path: string): Promise<ImageContent | null> {
	const source = sourceFingerprint(path);
	if (!source) return null; // 文件不存在

	const cached = inlineCache.get(path);
	if (cached && cached.source === source && cached.profile === COMPRESS_PROFILE) return cached.image;

	const hash = hashFromLocalPath(path);
	// 磁盘二级缓存
	try {
		const raw = readFileSync(inlineCachePath(hash), "utf8");
		const parsed = JSON.parse(raw) as { data?: string; mimeType?: string; profile?: string; source?: string };
		if (
			parsed &&
			typeof parsed.data === "string" &&
			typeof parsed.mimeType === "string" &&
			parsed.profile === COMPRESS_PROFILE &&
			parsed.source === source
		) {
			const image: ImageContent = { type: "image", data: parsed.data, mimeType: parsed.mimeType };
			inlineCache.set(path, { source, profile: COMPRESS_PROFILE, image });
			stats.cacheHits++;
			return image;
		}
	} catch {
		// 继续
	}

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(path));
	} catch {
		return null;
	}
	const mime = sniffMime(bytes) ?? EXT_MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
	if (!mime || !mime.startsWith("image/")) return null;

	const inline = await compressImage(bytes, mime);
	inlineCache.set(path, { source, profile: COMPRESS_PROFILE, image: inline });
	try {
		ensureDataDir();
		writeJsonAtomic(inlineCachePath(hash), {
			mimeType: inline.mimeType,
			data: inline.data,
			profile: COMPRESS_PROFILE,
			source,
		});
	} catch {
		// 二级缓存写失败无所谓
	}
	return inline;
}

// ---------------------------------------------------------------- 文本替换 / 展开

export interface ReplaceResult {
	text: string;
	/** 成功内联的图片数 */
	images: number;
	/** 成功保存的普通文件数 */
	files: number;
	/** 下载失败保留原样的标记 */
	failed: string[];
	/** 超过单条上限保留原样的标记 */
	skipped: string[];
}

/**
 * 把文本里的直链标记替换成：
 *   图片 → `[img:<本地路径>]`（供 context 展开为多模态块）
 *   其他 → `<本地路径>`
 * 【全同步】：所有文件完整落盘后才返回，消息才发给 API —— 模型不可能碰到
 * 未就绪/不完整的文件。下载失败的标记原样保留（模型可用工具抓原链兕底）。
 */
export async function replaceMarkers(text: string): Promise<ReplaceResult> {
	const segments = splitSegments(text);
	const markers = segments.filter((s): s is MarkerSegment => s.type === "marker");

	// 全部下载并发启动，等所有文件完整落盘（重复 URL 由缓存兕底不重下）
	const limit = markers.slice(0, MAX_PER_MESSAGE);
	const jobs = limit.map((m) => ({ marker: m, ...startFile(m.url, m.kind) }));
	await Promise.all(jobs.map((j) => j.promise));

	let out = "";
	let imageCount = 0;
	let fileCount = 0;
	const failed: string[] = [];
	const skipped: string[] = [];
	let index = 0;

	for (const seg of segments) {
		if (seg.type === "text") {
			out += seg.text;
			continue;
		}
		const i = index++;
		if (i >= limit.length) {
			out += seg.raw;
			skipped.push(seg.raw);
			continue;
		}
		const job = jobs[i];
		if (seg.isImage) {
			const r = await job.promise; // 上面已等完，立即返回
			if (r.ok && r.path) {
				out += `[${REF_PREFIX}:${r.path}]`;
				imageCount++;
			} else {
				out += seg.raw;
				failed.push(seg.raw);
			}
		} else {
			const r = await job.promise; // 上面已等完，立即返回
			if (r.ok && r.path) {
				out += job.path;
				fileCount++;
			} else {
				out += seg.raw;
				failed.push(seg.raw);
			}
		}
	}

	return { text: out, images: imageCount, files: fileCount, failed, skipped };
}

export interface ExpandResult {
	blocks: (TextContent | ImageContent)[];
	changed: boolean;
	/** 引用存在但图片读取失败的标记 */
	failed: string[];
}

/**
 * 把文本里的 `[img:<本地路径>]` 引用展开成 交错的文本/图片块。
 * 展开后的引用文字变成 `(image: <路径>)`（幂等：不会重复展开）。
 */
export async function expandRefs(text: string): Promise<ExpandResult> {
	if (!hasRef(text)) return { blocks: [{ type: "text", text }], changed: false, failed: [] };

	const segments = splitRefs(text);
	const blocks: (TextContent | ImageContent)[] = [];
	const failed: string[] = [];
	let pending = "";
	let changed = false;

	const flush = () => {
		if (pending !== "") blocks.push({ type: "text", text: pending });
		pending = "";
	};

	for (const seg of segments) {
		if (seg.type === "text") {
			pending += seg.text;
			continue;
		}
		const image = await getInlineImage(seg.path);
		if (image) {
			flush();
			blocks.push(image);
			pending += `(image: ${seg.path})`;
			changed = true;
		} else {
			pending += seg.raw;
			failed.push(seg.raw);
		}
	}
	flush();
	return { blocks, changed, failed };
}

/**
 * context 钩子用：直链标记 + 本地图片引用 一步到位
 * （URL 标记 → 落盘并引用；图片引用 → 多模态图片块）
 */
export async function transformText(text: string): Promise<ExpandResult> {
	if (!hasInlineable(text)) return { blocks: [{ type: "text", text }], changed: false, failed: [] };
	const replaced = hasMarker(text) ? await replaceMarkers(text) : null;
	const expanded = await expandRefs(replaced ? replaced.text : text);
	return {
		blocks: expanded.blocks,
		changed: (replaced ? replaced.images + replaced.files : 0) + (expanded.changed ? 1 : 0) > 0,
		failed: [...(replaced?.failed ?? []), ...expanded.failed],
	};
}

// ---------------------------------------------------------------- 统计

const stats = {
	filesSaved: 0,
	imagesInlined: 0,
	bytesDownloaded: 0,
	bytesInline: 0,
	cacheHits: 0,
	failed: 0,
};

export function getStats() {
	return { ...stats, dataDir: DATA_DIR, memoryImages: inlineCache.size, memoryFiles: acquireCache.size };
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- 扩展入口

interface MutableMessage {
	role: string;
	content?: string | (TextContent | ImageContent)[];
	output?: string;
	timestamp: number;
}

/** 幂等保障：展开后引用文字变成 `(image: path)`，不再匹配标记正则，
 * 因此无论 messages 对象是否被复用/重建，都不会重复注入。 */
async function expandContentBlocks(content: (TextContent | ImageContent)[]): Promise<(TextContent | ImageContent)[]> {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (block.type !== "text" || !hasInlineable(block.text)) {
			out.push(block);
			continue;
		}
		const r = await transformText(block.text);
		out.push(...r.blocks);
	}
	return out;
}

export default function inlineImages(pi: ExtensionAPI): void {
	// 1) 用户输入：直链标记 → 本地路径引用（会话记录保持轻量）
	pi.on("input", async (event, ctx) => {
		if (!hasMarker(event.text)) return { action: "continue" };

		const r = await replaceMarkers(event.text);
		stats.imagesInlined += r.images;

		if (r.failed.length > 0) {
			ctx.ui?.notify?.(`[inline-images] ${r.failed.length} 个直链下载失败，标记已保留`, "warning");
		}

		return { action: "transform", text: r.text };
	});

	// 2) 工具结果：同样替换成路径引用（不直接塞多模态，交给 context）
	pi.on("tool_result", async (event) => {
		const content = event.content;
		if (!Array.isArray(content) || !content.some((b) => b.type === "text" && hasMarker(b.text))) return;

		const out: (TextContent | ImageContent)[] = [];
		for (const block of content) {
			if (block.type !== "text" || !hasMarker(block.text)) {
				out.push(block);
				continue;
			}
			const r = await replaceMarkers(block.text);
			stats.imagesInlined += r.images;
			out.push({ type: "text", text: r.text });
		}
		return { content: out };
	});

	// 3) context：发模型前把引用展开成多模态图片块（请求本地、幂等）
	pi.on("context", async (event) => {
		const messages = event.messages as unknown as MutableMessage[];
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			try {
				if (msg.role === "bashExecution" && typeof msg.output === "string" && hasInlineable(msg.output)) {
					const r = await transformText(msg.output);
					messages[i] = {
						role: "user",
						content: r.blocks.length > 0 ? r.blocks : [{ type: "text", text: msg.output }],
						timestamp: msg.timestamp,
					};
					continue;
				}
				if (msg.role !== "user" && msg.role !== "custom" && msg.role !== "toolResult") continue;
				if (typeof msg.content === "string") {
					if (!hasInlineable(msg.content)) continue;
					const r = await transformText(msg.content);
					stats.imagesInlined += r.blocks.filter((b) => b.type === "image").length;
					msg.content = r.blocks.length > 0 ? r.blocks : [{ type: "text", text: msg.content }];
				} else if (Array.isArray(msg.content)) {
					if (!msg.content.some((b) => b.type === "text" && hasInlineable(b.text))) continue;
					const next = await expandContentBlocks(msg.content);
					stats.imagesInlined += next.filter((b) => b.type === "image").length;
					msg.content = next;
				}
			} catch (err) {
				ctx.ui?.notify?.(
					`[inline-images] 处理消息出错: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}
	});

	pi.on("session_shutdown", () => {
		clearCaches();
	});

	pi.registerCommand("inline-images", {
		description: "Show pi-inline-images stats and configuration",
		handler: async (_args, ctx) => {
			const compressor = NO_COMPRESS ? "关闭" : (await loadProcessImage()) ? "pi 内置 processImage" : "不可用(原图直发)";
			const msg = [
				`pi-inline-images · 数据目录: ${DATA_DIR}`,
				`本次会话: 内联图片 ${stats.imagesInlined} 张 · 保存文件 ${stats.filesSaved} 个 · 缓存命中 ${stats.cacheHits} 次 · 失败 ${stats.failed} 次`,
				`失败记录 ${failureByPath.size} 条`,
				`流量: 下载 ${formatBytes(stats.bytesDownloaded)} · 压缩后 ${formatBytes(stats.bytesInline)}`,
				`压缩: ${compressor} · 目标 ${RESIZE_MAX_W}x${RESIZE_MAX_H} · JPEG Q${RESIZE_JPEG_Q} · 上限 ${formatBytes(RESIZE_MAX_B64_BYTES)}`,
				`限制: 单文件 ${formatBytes(MAX_BYTES)} · 超时 ${TIMEOUT_MS}ms · 单条最多 ${MAX_PER_MESSAGE} 个标记`,
				`写法: [png:https://…] 图片内联多模态 · [srt:https://…] 等其它类型转本地路径`,
			].join("\n");
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});
}
