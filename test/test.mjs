// pi-inline-images 单元测试 + 性能基准：node test/test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import zlib from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// 压缩依赖 pi 内置 processImage：显式指定其 dist 目录（单测在 pi 进程外）
function findPiDist() {
	try {
		const real = realpathSync(execSync("which pi", { encoding: "utf8" }).trim());
		let dir = dirname(real);
		for (let i = 0; i < 8; i++) {
			if (existsSync(join(dir, "utils", "image-process.js"))) return dir;
			if (existsSync(join(dir, "dist", "utils", "image-process.js"))) return join(dir, "dist");
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {}
	return null;
}
const piDist = findPiDist();
if (piDist) process.env.PI_INLINE_IMAGES_PI_DIST = piDist;
else console.log("(未找到 pi 安装目录，跳过压缩测试)");

process.env.PI_INLINE_IMAGES_MAX_MB = "0.001"; // ≈1 KB，便于测超限
process.env.PI_INLINE_IMAGES_TIMEOUT_MS = "3000";

const mod = await import("../pi-inline-images.ts");
const {
	splitSegments,
	splitRefs,
	hasMarker,
	hasRef,
	hasInlineable,
	sniffMime,
	acquireFile,
	replaceMarkers,
	expandRefs,
	transformText,
	getInlineImage,
	compressImage,
	startFile,
	setDataDir,
	clearCaches,
} = mod;

const dataDir = mkdtempSync(join(tmpdir(), "pi-inline-images-test-"));
setDataDir(dataDir);

// ---- 测试素材
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const SRT_BYTES = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nhello subtitle\n");
const MP3_BYTES = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 2)]);
const BIG_BYTES = Buffer.alloc(5 * 1024, 7);

let hits = 0;
const server = http.createServer((req, res) => {
	hits++;
	if (req.url === "/i/ok.png") {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(PNG_BYTES);
	} else if (req.url === "/i/pic.jpg") {
		res.writeHead(200, { "content-type": "image/jpeg" });
		res.end(JPEG_BYTES);
	} else if (req.url === "/i/anim.gif") {
		res.writeHead(200, { "content-type": "image/gif" });
		res.end(GIF_BYTES);
	} else if (req.url === "/files/sub.srt") {
		res.writeHead(200, { "content-type": "application/x-subrip" });
		res.end(SRT_BYTES);
	} else if (req.url === "/files/track.mp3") {
		res.writeHead(200, { "content-type": "audio/mpeg" });
		res.end(MP3_BYTES);
	} else if (req.url === "/slow/sub.srt") {
		setTimeout(() => {
			res.writeHead(200, { "content-type": "application/x-subrip" });
			res.end(SRT_BYTES);
		}, 300);
	} else if (req.url === "/slow/atomic.png") {
		setTimeout(() => {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(PNG_BYTES);
		}, 300);
	} else if (req.url === "/i/big.png") {
		res.writeHead(200, { "content-type": "image/png", "content-length": String(BIG_BYTES.length) });
		res.end(BIG_BYTES);
	} else {
		res.writeHead(404);
		res.end("not found");
	}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const check = async (name, fn) => {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}: ${e.message}`);
		process.exitCode = 1;
	}
};

console.log("sniffMime");
await check("PNG / JPEG / GIF 魔数", () => {
	assert.equal(sniffMime(PNG_BYTES), "image/png");
	assert.equal(sniffMime(JPEG_BYTES), "image/jpeg");
	assert.equal(sniffMime(GIF_BYTES), "image/gif");
});
await check("WEBP / AVIF / SVG / 未知", () => {
	const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
	const avif = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif"), Buffer.alloc(8)]);
	assert.equal(sniffMime(webp), "image/webp");
	assert.equal(sniffMime(avif), "image/avif");
	assert.equal(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
	assert.equal(sniffMime(Buffer.from("hello")), undefined);
});

console.log("标记解析（多链接 / 混合类型）");
await check("识别直链标记与本地引用", () => {
	assert.equal(hasMarker("看 [png:https://a.com/x.png]"), true);
	assert.equal(hasMarker("文件 [srt:https://a.com/x.srt]"), true);
	assert.equal(hasRef("图 [img:/tmp/x.png]"), true);
	assert.equal(hasRef("图 [img:https://a.com/x.png]"), false); // URL 标记不算本地引用
	assert.equal(hasInlineable("普通文本"), false);
});
await check("一条消息多个标记按序切分", () => {
	const segs = splitSegments(`图一 [png:${base}/i/ok.png] 字幕 [srt:${base}/files/sub.srt] 音频 [mp3:${base}/files/track.mp3] 完`);
	assert.equal(segs.filter((s) => s.type === "marker").length, 3);
	assert.deepEqual(
		segmentsTypes(segs),
		["text", "marker", "text", "marker", "text", "marker", "text"],
	);
	assert.equal(segs[1].isImage, true);
	assert.equal(segs[3].isImage, false);
	assert.equal(segs[5].kind, "mp3");
});
await check("本地引用切分", () => {
	const segs = splitRefs(`前 [img:/data/a.png] 后 [img:/data/b.jpg]`);
	assert.deepEqual(
		segs.map((s) => s.type),
		["text", "ref", "text", "ref"],
	);
	assert.equal(segs[1].path, "/data/a.png");
});

console.log("acquireFile（下载 + 落盘 + 去重）");
await check("下载文件落盘并写 meta", async () => {
	const r = await acquireFile(`${base}/files/sub.srt`, "srt");
	assert.equal(r.ok, true);
	assert.equal(r.isImage, false);
	assert.ok(existsSync(r.path), "文件已落盘");
	assert.equal(readFileSync(r.path, "utf8"), SRT_BYTES.toString("utf8"));
	const meta = JSON.parse(readFileSync(r.path.replace(/[^.]+$/, "") + "meta.json", "utf8"));
	assert.equal(meta.url, `${base}/files/sub.srt`);
	assert.equal(meta.ext, "srt");
});
await check("同 URL 磁盘缓存命中不重复下载", async () => {
	clearCaches();
	const before = hits;
	const r = await acquireFile(`${base}/files/sub.srt`, "srt");
	assert.equal(r.ok, true);
	assert.equal(r.fromCache, true);
	assert.equal(hits, before, "没有发起新请求");
});
await check("音频文件按普通文件处理", async () => {
	const r = await acquireFile(`${base}/files/track.mp3`, "mp3");
	assert.equal(r.ok, true);
	assert.equal(r.isImage, false);
	assert.ok(r.path.endsWith(".mp3"));
});
await check("404 / 超限报错", async () => {
	const r1 = await acquireFile(`${base}/i/gone.png`, "png");
	assert.equal(r1.ok, false);
	assert.match(r1.error, /HTTP 404/);
	const r2 = await acquireFile(`${base}/i/big.png`, "png");
	assert.equal(r2.ok, false);
	assert.match(r2.error, /文件过大/);
});

console.log("replaceMarkers（文本替换）");
await check("图片 → [img:路径] 引用", async () => {
	const r = await replaceMarkers(`看图 [png:${base}/i/ok.png] 好`);
	assert.equal(r.images, 1);
	assert.equal(r.files, 0);
	assert.match(r.text, /^看图 \[img:.+\.png\] 好$/);
	assert.ok(!r.text.includes("http"), "链接已截掉");
});
await check("非图片 → 纯本地路径", async () => {
	const r = await replaceMarkers(`字幕在 [srt:${base}/files/sub.srt] 里`);
	assert.equal(r.images, 0);
	assert.equal(r.files, 1);
	assert.match(r.text, /^字幕在 .+\.srt 里$/);
	assert.ok(!r.text.includes("http"), "链接已截掉");
	assert.ok(!r.text.includes("[img:"), "不是图片引用形式");
});
await check("多链接混合（2图+字幕+音频）全部处理", async () => {
	const r = await replaceMarkers(
		`[png:${base}/i/ok.png] 和 [gif:${base}/i/anim.gif]，字幕 [srt:${base}/files/sub.srt]，音频 [mp3:${base}/files/track.mp3] 一起看`,
	);
	assert.equal(r.images, 2);
	assert.equal(r.files, 2);
	assert.equal(r.failed.length, 0);
	assert.ok(!r.text.includes("http"), "所有链接已截掉");
	const parts = r.text.split(/\s+/);
	assert.match(r.text, /\[img:.+\.png\].*\[img:.+\.gif\].*\.srt.*\.mp3/s, "顺序保持");
});
await check("下载失败的标记原样保留", async () => {
	const r = await replaceMarkers(`坏图 [png:${base}/i/gone.png] 坏文件 [srt:${base}/files/gone.srt] 结束`);
	assert.equal(r.failed.length, 2);
	assert.ok(r.text.includes("[png:"), "失败图片标记保留");
	assert.ok(r.text.includes("[srt:"), "失败文件标记保留");
});
await check("全同步：返回时文件已完整落盘（慢速下载也不发半成品）", async () => {
	clearCaches();
	const t0 = Date.now();
	const r = await replaceMarkers(`慢文件 [srt:${base}/slow/sub.srt] 完成`);
	const elapsed = Date.now() - t0;
	assert.equal(r.files, 1);
	assert.ok(elapsed >= 250, `应等下载完成，实际 ${elapsed}ms`);
	const path = r.text.match(/\[(?:srt):([^\]]+)\]/) ? null : r.text.match(/完成/) && r.text.split(" ")[1];
	assert.ok(path && existsSync(path), `返回时文件已落盘: ${path}`);
	assert.equal(readFileSync(path, "utf8"), SRT_BYTES.toString("utf8"), "内容完整");
});

console.log("expandRefs + transformText（多模态注入）");
// 先准备一张本地图片（模拟已落盘的文件）
writeFileSync(join(dataDir, "x.png"), PNG_BYTES);
await check("引用展开为交错图片块", async () => {
	clearCaches();
	const r = await expandRefs(`看下 [img:${dataDir}/x.png] 好不好`);
	assert.equal(r.changed, true);
	assert.deepEqual(
		r.blocks.map((b) => b.type),
		["text", "image", "text"],
	);
	assert.ok(r.blocks[0].text.startsWith("看下 "));
	assert.ok(r.blocks[2].text.includes("(image:"));
	assert.ok(!r.blocks[2].text.includes("[img:"), "引用标记已消费");
});
await check("展开幂等（二次处理不重复注入）", async () => {
	const first = await expandRefs(`图 [img:${dataDir}/x.png] 好`);
	const again = await expandRefs(first.blocks.map((b) => (b.type === "text" ? b.text : "")).join(""));
	assert.equal(again.changed, false, "已消费的文本不再展开");
	assert.equal(again.blocks.filter((b) => b.type === "image").length, 0);
});
await check("失效引用保留原样", async () => {
	const r = await expandRefs(`丢图 [img:${dataDir}/missing.png] 嗯`);
	assert.equal(r.changed, false);
	assert.ok(r.blocks[0].text.includes("[img:"), "失效引用保留");
	assert.equal(r.failed.length, 1);
});
await check("transformText 处理历史残留 URL 标记", async () => {
	const r = await transformText(`老消息 [png:${base}/i/ok.png] 还有 [img:${dataDir}/x.png]`);
	const types = r.blocks.map((b) => b.type);
	assert.ok(types.includes("image"), "含图片块");
	assert.equal(types.filter((t) => t === "image").length, 2, "两张图都注入");
});
await check("getInlineImage 读取本地任意图片", async () => {
	const img = await getInlineImage(`${dataDir}/x.png`);
	assert.ok(img && img.type === "image");
	assert.ok(img.data.length > 0);
});
await check("一致性：未变化时重复取用 base64 逐字节一致", async () => {
	const p = join(dataDir, "stable.png");
	writeFileSync(p, PNG_BYTES);
	const a = await getInlineImage(p);
	const b = await getInlineImage(p);
	assert.equal(a.data, b.data, "内存复用逐字节一致");
	const raw = JSON.parse(readFileSync(join(dataDir, "stable.inline.json"), "utf8"));
	assert.equal(raw.data, a.data, "磁盘缓存与内存一致");
	assert.ok(raw.profile && raw.source, "缓存含来源+参数指纹");
});
await check("一致性：清空内存缓存（模拟重启/fork 重放）后仍逐字节一致", async () => {
	const p = join(dataDir, "persist.png");
	writeFileSync(p, PNG_BYTES);
	const a = await getInlineImage(p);
	clearCaches(); // 模拟进程重启 / 切换分支后重建上下文：只剩磁盘缓存
	const b = await getInlineImage(p);
	assert.equal(a.data, b.data, "磁盘缓存保证跨重启一致");
	const c = await expandRefs(`看图 [img:${p}] 说明`);
	const img = c.blocks.find((x) => x.type === "image");
	assert.equal(img.data, a.data, "任意时机展开结果逐字节一致");
});
await check("指纹校验：同路径文件改写后缓存失效、内容更新", async () => {
	const p = join(dataDir, "mut.png");
	writeFileSync(p, PNG_BYTES);
	const a = await getInlineImage(p);
	assert.equal(a.mimeType, "image/png");
	await new Promise((r) => setTimeout(r, 20));
	writeFileSync(p, GIF_BYTES);
	const b = await getInlineImage(p);
	assert.equal(b.mimeType, "image/gif", "文件改写后返回新内容");
});

console.log("预压缩（复用 pi 内置 processImage）");
if (piDist) {
	// 生成 3000x2000 渐变 PNG（远超 1536 目标边）
	function makePng(w, h) {
		const raw = Buffer.alloc((w * 3 + 1) * h);
		let o = 0;
		for (let y = 0; y < h; y++) {
			raw[o++] = 0;
			for (let x = 0; x < w; x++) {
				raw[o++] = (x * 255) / w;
				raw[o++] = (y * 255) / h;
				raw[o++] = 128;
			}
		}
		const chunk = (type, data) => {
			const len = Buffer.alloc(4);
			len.writeUInt32BE(data.length);
			const td = Buffer.concat([Buffer.from(type), data]);
			const crc = Buffer.alloc(4);
			crc.writeUInt32BE(zlib.crc32(td));
			return Buffer.concat([len, td, crc]);
		};
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", (() => {
				const d = Buffer.alloc(13);
				d.writeUInt32BE(w, 0);
				d.writeUInt32BE(h, 4);
				d[8] = 8;
				d[9] = 2;
				return d;
			})()),
			chunk("IDAT", zlib.deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]);
	}

	await check("大图预压缩：体积显著下降", async () => {
		const big = makePng(3000, 2000);
		const r = await compressImage(big, "image/png");
		const outBytes = Math.floor((r.data.length * 3) / 4);
		console.log(`    3000x2000 PNG: 原图 ${(big.length / 1024).toFixed(0)}KB → 发送 ${(outBytes / 1024).toFixed(0)}KB (${r.mimeType})`);
		assert.ok(r.data.length > 0);
		assert.ok(outBytes < big.length * 0.6, `体积应显著下降，实际 ${outBytes} vs ${big.length}`);
		assert.ok(r.mimeType.startsWith("image/"));
	});
	await check("小图不放大不降质", async () => {
		const before = PNG_BYTES.length;
		const r = await compressImage(PNG_BYTES, "image/png");
		const outBytes = Math.floor((r.data.length * 3) / 4);
		assert.ok(outBytes <= before * 1.1, `小图体积不应膨胀：${outBytes} vs ${before}`);
	});
}

await check("原子落盘：下载完成前不存在半个文件", async () => {
	clearCaches();
	const started = startFile(`${base}/slow/atomic.png`, "png");
	assert.ok(!existsSync(started.path), "下载中文件不可见");
	const r = await started.promise;
	assert.ok(r.ok, r.error || "");
	assert.ok(existsSync(started.path), "完成后原子出现");
	assert.equal(readFileSync(started.path).length, PNG_BYTES.length, "内容完整");
});

// ---- 性能基准
console.log("性能基准");
{
	const plainText = "这是一条普通的用户消息，没有任何直链标记，讨论一下项目进度和后续安排。".repeat(3);
	const n = 500;
	const t0 = performance.now();
	let hitCount = 0;
	for (let i = 0; i < n; i++) if (hasInlineable(plainText)) hitCount++;
	const scanMs = performance.now() - t0;
	await check(`无标记消息快速早退（${n} 次 ${plainText.length} 字符）: ${scanMs.toFixed(2)}ms`, () => {
		assert.equal(hitCount, 0);
		assert.ok(scanMs < 50, `扫描应 <50ms，实际 ${scanMs.toFixed(2)}ms`);
	});

	const refText = `看图 [img:${dataDir}/x.png] 说明一下`;
	await transformText(refText); // 预热缓存
	const t1 = performance.now();
	for (let i = 0; i < 50; i++) await transformText(refText);
	const expandMs = (performance.now() - t1) / 50;
	await check(`含图消息重复展开（缓存命中）: ${expandMs.toFixed(2)}ms/次`, () => {
		assert.ok(expandMs < 5, `缓存命中应 <5ms，实际 ${expandMs.toFixed(2)}ms`);
	});
}

await new Promise((r) => server.close(r));
console.log(`\n${passed} 项通过${process.exitCode ? "（有失败）" : ""}`);
console.log(`数据目录: ${dataDir}`);

function segmentsTypes(segs) {
	return segs.map((s) => s.type);
}
