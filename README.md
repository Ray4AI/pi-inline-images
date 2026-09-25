# pi-inline-images

给 [pi](https://github.com/earendil-works/pi) 用的扩展：把消息里的**文件直链标记**（`[png:https://…]`、`[srt:https://…]` 等）在本地落地，并就地转换——

- **图片**：下载 → 预压缩（省 token）→ 发模型时以多模态图片块随**本次请求**直达，模型不再需要"下载 + read"一来一回的工具调用
- **其他文件**（srt / mp3 / mp4 / txt / zip / 任意类型）：下载存盘 → 文本里替换成**本地路径**，模型直接用 read / bash / grep 处理
- 一条消息里可混排**任意多个链接**（多图、图+文件、图+音频…），全部并发下载、按序就位
- 会话记录里只存**路径引用**（不存 base64），会话文件轻量；原文件永久保存在数据目录，**信息不丢**

## 效果

发送：

```
组图 [png:https://img.raykari.com/i/gaRP1wyoEsXn6HziYDG25g.png]，字幕 [srt:https://img.raykari.com/i/QqE6VWqU_VFL6-PlGzHQgg.srt]
```

会话记录（持久化）里是：

```
组图 [img:/home/me/.pi/agent/pi-inline-images/1d331f6f….png]，字幕 /home/me/.pi/agent/pi-inline-images/f9d9cf16….srt
```

发给模型的请求里：图片以 `image` 内容块真实附在消息中（模型直接"看图"），字幕路径可直接 read。

## 标记写法

```
[<类型>:<http(s) 直链>]
```

| 类型 | 处理 |
|---|---|
| `png` `jpg` `jpeg` `gif` `webp` `bmp` `avif` `svg` `img` `image` | 图片：预压缩后以多模态块随请求发送 |
| 其它任意 1-10 位类型（`srt` `mp3` `mp4` `txt` `zip` `file` …） | 文件：存盘，替换成绝对路径 |

- 实际 MIME 按**魔数嗅探**为准（标记写错类型也不会发错格式）
- 下载失败的标记**原样保留**，模型可用工具抓原始链接兜底

## 工作方式

| 钩子 | 时机 | 行为 |
|---|---|---|
| `input` | 用户发消息 | 标记 → 落盘 + 路径引用（全同步：**所有文件完整落盘后消息才发给 API**） |
| `tool_result` | 工具输出含标记 | 同上 |
| `context` | 每次请求前 | 把 `[img:路径]` 引用展开成多模态图片块（请求本地、幂等） |

**数据目录** `~/.pi/agent/pi-inline-images/`：

```
<hash>.png          原文件（按 URL 去重，原子落盘）
<hash>.meta.json    来源 URL / 类型 / 大小 / 时间
<hash>.inline.json  预压缩结果（发给模型的 base64 缓存）
```

> **引用指向原图**：`[img:<路径>]` 里的路径是**原图**（保真、可追溯，模型看不清时还能自己 read 原图）；
> 压缩版只作为“发送视图”存在 `.inline.json` 里。两者由指纹绑定：原图没变，发送视图就不变。
> **base64 只存在于** `.inline.json` + 运行时内存缓存 + 当次请求体；会话文件里永远只有路径引用。

### 为什么快

- **无标记消息零成本**：一次正则早退（~0.3μs/条）
- **全同步但并发**：多链接并行下载；重复 URL 磁盘缓存直接命中不重下
- **预压缩只做一次**：下载时压缩，内存 + 磁盘双缓存，后续请求纯引用复用（~0.01ms）
- **压缩效果**：3000×2000 截图 237KB → 33KB（−86%）；小图不放大不降质
- 原子落盘：先写 `.part` 再 rename，模型永远读不到半个文件
- **失败节流**：60s 内不重复请求同一个失败链接
- **缓存指纹**：内容/参数变了才重新压缩，否则纯引用复用（见上节）

> 语义选择：宁可发送前多等下载，也不让模型“读不到文件”——后者反而多一轮往返，更慢。

## 上下文一致性（prompt cache 不断）

多模态内容不进会话文件：会话里只有 `[img:path]` 文本引用，每次请求前 `context` 钩子才展开成图片块。展开用的 base64 来自“压缩一次 + 落盘固化”的 `<hash>.inline.json`，并带两道指纹校验：

- **来源指纹**（源文件大小 + mtime）——同路径文件被改写时缓存自动失效；
- **压缩参数指纹**（尺寸/质量/上限）——调整参数后自动重新压缩。

因此同一张图在第 1 次和第 N 次请求中（包括重启 pi、恢复会话后）展开出的 base64 **逐字节一致**，provider 侧 prompt cache 前缀稳定命中，不会被意外打断。

只有两种情况图片内容会变（属于“内容真的变了”，不可避免）：① 源文件被改写；② 你调整了压缩参数——此时从该图起 cache 重新写一次。另外：base64 仍会随每次请求传输（多模态缓存机制如此），但命中 cache read 的计费远低于重新处理。

## 安装

**推荐：pi 包管理（安装 / 卸载 / 更新一条命令）**

```bash
pi install git:github.com/Ray4AI/pi-inline-images     # 安装（个人级，写入 ~/.pi/agent/settings.json）
pi list                                               # 查看已安装包
pi update --extensions                                # 更新到最新
pi remove git:github.com/Ray4AI/pi-inline-images     # 卸载
```

项目级安装加 `--local`（写入 `.pi/settings.json`，需项目信任后生效）。

**开发 / 手动安装（备选）**

```bash
# Linux/macOS
git clone https://github.com/Ray4AI/pi-inline-images && cd pi-inline-images
./install.sh          # 复制到 ~/.pi/agent/extensions/；--link 为软链开发模式

# Windows（PowerShell）
git clone https://github.com/Ray4AI/pi-inline-images
cd pi-inline-images
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

重启 pi（或 `/reload`）生效。无任何 npm 依赖。

## 配置（环境变量，均可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_INLINE_IMAGES_DIR` | `~/.pi/agent/pi-inline-images` | 数据目录 |
| `PI_INLINE_IMAGES_MAX_MB` | `20` | 单文件大小上限（MB） |
| `PI_INLINE_IMAGES_TIMEOUT_MS` | `20000` | 下载超时（ms） |
| `PI_INLINE_IMAGES_MAX_PER_MESSAGE` | `24` | 单条消息最多处理的标记数 |
| `PI_INLINE_IMAGES_MAX_W` / `MAX_H` | `1536` | 图片压缩目标最大宽/高 |
| `PI_INLINE_IMAGES_JPEG_Q` | `75` | 压缩 JPEG 质量 |
| `PI_INLINE_IMAGES_INLINE_MAX_KB` | `1200` | 压缩后 base64 上限（KB） |
| `PI_INLINE_IMAGES_NO_COMPRESS` | — | 置 `1` 关闭预压缩 |
| `PI_INLINE_IMAGES_PI_DIST` | 自动探测 | pi 安装目录（压缩找不到时手动指定） |

压缩复用 pi 内置的 `processImage`（read 工具贴图同款 Photon/WASM 管线），无需额外依赖。

## 命令

`/inline-images` —— 内联统计（图片数 / 文件数 / 缓存命中 / 流量 / 压缩效果）与当前配置。

## 测试

```bash
node test/test.mjs    # 24 项单元测试 + 性能基准（本地 HTTP 服务模拟直链）
```

## 说明

- 音频 / 视频按普通文件处理（存盘 + 路径）：pi 的消息内容块只支持文本和图片
- 图片原图保真保存；发给模型的是预压缩版（可调目标尺寸/质量）
- 插件不修改 pi 任何内置工具的行为，只负责"消息发送前把一切准备好"
