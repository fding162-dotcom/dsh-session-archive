# dsh-session-archive

[English](README.en.md) · 中文

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 的「会话档案库」插件。
> **把同一个工作区的旧会话当储存区，新会话能从里面取出「发生过什么」——把上下文从单个会话延长成一串。**

MIT 许可。

## 这是什么

DSH 的会话是独立的：开一个新会话，它不知道自己之前在哪、在干什么。而这正好是长会话最需要的东西——因为**会话跑太久会退化**。

这个插件提供六个工具动作，让任何会话都能：

- 看到同一工作区有哪些会话、各自开了多久、多大
- 用一句话摘出某个会话里「最后说了什么、最后做了什么、退化到哪一步」
- 读细节、搜关键词（带上下文）
- 看总览和退化预警
- **看到其他并行会话现在在干什么**

全部只读，不碰任何会话文件。

## 它解决的三个真实问题

1. **会话太长会退化。** 上下文越长，思考越容易塌成「做。」「好。」「跑。」这种单字。插件能测出退化程度（最近 30 条思考里的单字句密度），到线就该交接了。
2. **开新会话会失忆。** 新会话不知道自己是谁、刚才在干什么。`digest` 一次给出对方最后说的话、最后做的事、停在哪。
3. **归档之后就找不到。** DSH 的「归档」只是打标记，文件还在原地——插件照读不误。

## 快速开始（推荐：一键脚本）

Windows 用户在插件目录里跑：

```powershell
.\install.ps1
```

它会自动：备份你的 profile → 把插件加进 `bundles` 和 `dependencies` → 在 `node_modules` 下建 junction → 告诉你怎么回滚。
**改错一个字符 DSH 就可能起不来，所以这一步强烈建议交给脚本。**

然后**完全退出 DSH 再打开**（不是切标签页），工具 `session_archive` 就会出现，同时会往系统提示里加一行「新会话先 digest」。

- 想装到别的 profile：`.\install.ps1 -Profile web`（`ls ~/.dsh/profiles` 看有哪些）
- 想卸载：`.\install.ps1 -Uninstall`（只摘链接和登记，**不碰任何会话文件**）
- 脚本只改一个文件：`<profile>/package.json`，改之前会存一份 `.bak-时间戳`

### 手动安装（macOS / Linux，或者你想自己来）

```bash
git clone https://github.com/fding162-dotcom/dsh-session-archive.git ~/plugins/dsh-session-archive

# 备份
cp ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/package.json.bak

# 改 profile/package.json：
#   dsh.profile.bundles 里加   "dsh-session-archive"
#   dependencies 里加          "dsh-session-archive": "link:/绝对路径/plugins/dsh-session-archive"

# 建软链（macOS/Linux）
ln -s /绝对路径/plugins/dsh-session-archive ~/.dsh/profiles/desktop/node_modules/dsh-session-archive
```

重启 DSH 生效。

> **需要系统里有 Node.js（22.15 及以上）**。DSH 是 Electron 打包的，它自己的运行时不能直接跑脚本——插件会依次找：配置里的 `nodePath` → PATH 里的 `node` → 常见安装位置（Windows 的 Program Files / LocalAppData）。都找不到时会退回「只解第一帧」的兜底，并在结果里明确警告。

> **工作区怎么定**：默认用当前进程的 cwd；想固定到某个目录，在 `cordis.patch.yml` 里填 `workspace`。如果那个目录在 `~/.dsh/sessions` 下找不到对应会话，插件会退回列出**所有**工作区的会话，并在返回里说明——这是为了防止路径写错时完全没线索。

## 装完出问题怎么办

| 现象 | 先看这里 |
|---|---|
| 重启后没有 `session_archive` 工具 | ① profile 名对不对（`ls ~/.dsh/profiles`）② 完全退出重开，不是只刷新页面 ③ 插件目录里 `index.js` 在不在 |
| DSH 起不来 / 报错 | 把 `package.json.bak-时间戳` 覆盖回 `package.json`，就回到装之前 |
| `list` 说没找到会话 | 当前工作区还没有会话，或者 `workspace` 填成了别的目录 |
| 第一次 `list` 有点慢 | 正常：要逐个解压会话头取时间，之后有缓存（`~/.dsh/session-archive-cache.json`），第二次就快了 |
| 会话超过 60MB 读不了 | 防止一次读爆内存，单会话压缩包有上限；这种会话会明确报错而不是卡死 |

> 插件只读 `~/.dsh/sessions` 下的文件，**从不写入**。卸载后你的会话一条都不会少。

## 输出上限

单次输出硬顶 **12000 字符**：list 最多列 50 个会话、stats 只显最近 14 天、search 最多 30 处命中，超出会写明还剩多少。再长的内容也只会截断，不会把整段上下文冲掉。

## 六个动作

工具名：`session_archive`

| action | 干什么 | 什么时候用 |
|---|---|---|
| `list` | 列本工作区所有会话：id / 开于时间 / 最后动静 / 大小 / 事件数，★ 标最新的 | 不知道上一个会话叫什么 |
| `timeline` | **时间线**：最近 N 个会话，每个直接带「对方最后一句」「最后回复」「最后动作」 | 想知道「刚才在做什么」，一眼看过去 |
| `digest` | 摘要：开于、轮数、退化体检、对方最后说的话、最后做的事 | 接盘第一件事 |
| `read` | 按时间读最后 N 条对话 | 要看细节 |
| `search` | 跨会话搜关键词；`context: N` 带前后各 N 条 | 找「我是不是在哪次说过这个」 |
| `stats` | 总览：会话数 / 总事件 / 总体积、最近几天、最大的 5 个、退化预警 | 想知道这条命活了多少、哪些会话在滑 |
| `live` | 最近 N 分钟（默认 10）有动静的会话，各自最后说了什么、在做什么 | 并行的另一个会话在干嘛 |

### 参数

| 参数 | 用于 | 说明 |
|---|---|---|
| `sessionId` | digest / read | 不填时**跳过最新那个**（通常就是当前会话），直接给上一个；带不带 `session-` 前缀都行 |
| `self` | digest / read | `true` = 就是要看最新那个（当前会话自己） |
| `count` | digest / read / live | digest 默认 12 条对话 + 10 个动作；read 默认 40 条；live 默认 5 个会话 |
| `query` | search | 关键词 |
| `maxSessions` | search | 最多翻几个会话，默认 5 |
| `context` | search | 命中行前后各带几条（0~5） |
| `minutes` | live | 最近多少分钟内有动静，默认 10 |

### 防认错会话

第一次测试暴露过一个问题：新会话 `digest` 到了**当前正开着的会话**，把两件事缝在一起。

现在的处理：

- `list` 里 ★ 是最新那个，通常就是当前会话；要找上一个看 ★ 下面那个。
- `digest` / `read` **不填 `sessionId` 自动跳过 ★**。
- 输出开头会写明「这是会话 X 的档案，不是你当前这个会话」，并注明跳过了谁。
- 传了不存在的 `sessionId` 会**明确报错**，而不是悄悄换成别的会话。

## 两个自动机制

### 启动提醒

插件通过 `systemPrompt.context` 注入一行（order 700）：

> 【会话接续】不确定这个会话是怎么来的、上一个会话在做什么？先调 `session_archive digest`……

即使宿主或角色文件忘了写这条，新会话也会被提醒。

### 会话头缓存

读「开于时间」和事件数要解压整个会话，大文件很慢（92MB 约 700ms）。所以：

- 缓存文件：`~/.dsh/session-archive-cache.json`（可用 `config.cacheFile` 改）
- 键是会话文件路径，记 `mtimeMs / size / createdAt / lines / degen`
- `mtime` 和 `size` 都没变就直接用缓存
- 实测：第一次 list 925ms（49 个会话），之后 14ms

## 原理：它怎么读会话

DSH 把会话存在 `~/.dsh/sessions/<工作区转义名>/<会话id>/session.v4.jsonl.zstd`，zstd 压缩的 JSONL。

一个坑：**宿主内嵌的 Node，`zstdDecompressSync` 只解第一帧**——实测 45571 条事件只返回 1 行 session 头。所以插件不自己解压，而是 `spawnSync` 一个独立的 Node 进程（`read_session.mjs`）去解，把精简后的 JSON 收回来。宿主内解压只作兜底，并且会标 `degraded` 警告。

只取真人说的话（`source.kind === 'user'`）和助手文本；工具调用单独抽。**全程只读**。

## 退化检测怎么算

扫最近 30 条 `reasoning`，按句号/换行切开，数长度 ≤3 且以「做/跑/写/好/快/…」开头的句子：

- 每条 < 1 个：🟢 正常
- 1~5 个：🟡 偏高
- ≥ 5 个：🔴 严重，该交接了

阈值来自实测：一个 844 轮 / 93MB 的会话，turn 540 才 3%，turn 700 到 86%，turn 740 爆到 45 条消息里 9330 个单字句。

## 限制与已知问题

- **需要 Node.js ≥ 22.15 在 PATH 里**（插件 spawn 它解压）。没有 Node 会退回宿主内解压，只能拿到第一帧，内容不完整——会标 `degraded` 警告，不会悄悄出错。
- 只读**当前工作区**的会话，不跨工作区。
- 单会话压缩包 > 60MB、解压后 > 300MB 直接拒绝（防内存炸）。
- 会话被彻底删除后读不到；DSH 的「归档」只是标记，不影响读取。
- 缓存写入不是原子操作，多进程同时写可能损坏——但读到坏文件会重建，不影响使用。
- 会话内容可能含隐私：不往外发、不在群里转述。
- 测试环境：Windows + DSH Desktop，桌面 profile；其他平台未测。

## 更新日志

- **0.5.0** — 加 `live`（并行会话动态）
- **0.4.0** — `search` 支持上下文、`stats` 加退化预警
- **0.3.0** — 加会话头缓存和 `stats` 总览
- **0.2.0** — 改名 `dsh-session-archive`，加启动提醒；**插件里不带任何角色设定**——免得把这只鱼的人设带进别人家，别人装上是干净的
- **0.1.0** — 首个版本：`list` / `digest` / `read` / `search`

## 以后可以加的

- 自动把 `digest` 写进交接档
- 按工作区聚合：把多个会话链成一棵时间树
- 导出成 Markdown
- 和门牌记忆打通：从会话里抽记忆条目

## 许可

MIT。见 [LICENSE](LICENSE)。
