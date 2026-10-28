# 写 DSH 插件踩过的坑

> 这些不是这个插件独有的，是写 DSH 插件普遍会撞上的。
> 全部来自一次真实的开发：`dsh-session-archive`，一天之内从「能跑」修到「敢给别人装」。
> 你要是正在写插件，希望能替你省掉几次重启。

## 七个坑

### 1. `process.execPath` 不是 node

**现象**：所有数据读出来都是空的、或者只有一点点，但不报错。

**原因**：DSH 是 Electron 打包的，`process.execPath` 指向 `DeepSeek Harness.exe`。你拿它去 `spawnSync` 跑脚本，只会再开一个 DSH，脚本根本没执行。

**写法**：

```js
const base = path.basename(process.execPath || '').toLowerCase()
const node = (base === 'node' || base === 'node.exe')
  ? process.execPath              // 普通 node 环境
  : 'node'                        // Electron 环境：去 PATH 里找
```

最好再加几个常见安装位置兜底（`C:/Program Files/nodejs/node.exe`、`%LOCALAPPDATA%/Programs/nodejs/node.exe`）。

### 2. 配置里不要写死工作区路径

`cordis.patch.yml` 里填了 `workspace: 'D:/我的项目'`，别人装上就在读你的目录。

**写法**：留空，用 `process.cwd()`。真要固定，让用户自己填。

### 3. DSH 的工作区目录转义：盘符的冒号是**删掉**

`D:\deepseek AI` → `--D-deepseek~0020AI--`

**规则**：`:` 删除，`\` 和 `/` 变 `-`，其余非 `[A-Za-z0-9_-]` 变 `~` + 4 位大写十六进制。

写成「冒号也变横线」会多出一个横线，**永远匹配不到**，然后静默回落。核对方法：拿 `ls ~/.dsh/sessions` 里的真实目录名反推一遍。

### 4. 批量传参会撞命令行长度上限

把所有文件路径一次性塞进一个 `spawnSync` 的参数，几十个没事，几百个就超过 Windows 约 3.2 万字符上限，**整批失败**，还静默。

**写法**：分批，比如每批 40 个。

### 5. 输出要限两层，不是一层

只限条数不够——单条消息本身可能几千字。

**写法**：限条数（列表最多 50 条）+ 限字符（总输出硬顶 12000），两个出口都包。

```js
function clampText(s, max = 12000) {
  const t = String(s == null ? '' : s)
  return t.length <= max ? t : t.slice(0, max) + `\n…（共 ${t.length} 字，已截断）`
}
```

### 6. 读到「空会话」和「正在被写的会话」不要静默

- 用户会建了不用的空会话（0 句对话）。按时间跳过最新后，可能正好落到它上面。
- DSH 重启/重写会话文件那几秒，读到的可能是空壳。

**写法**：读到事件数极少或 0 句对话的，明确提示「可能正在重写 / 这是空会话」；不填 id 时自动往前跳过空会话。

### 7. PowerShell 里空数组是 falsy

```powershell
if (-not $json.dsh.profile.bundles) { ... }   # [] 也是 falsy！
```

`Add-Member` 会报「成员已存在」，脚本直接崩。而**新用户的 profile 里 bundles 本来就是空的**。

**写法**：用成员存在性判断，不要用真假判断：

```powershell
if (-not $obj.PSObject.Properties['bundles']) { ... }
```

## 五条更值钱的

1. **本机跑通 ≠ 别人能用。** 发布前至少模拟一次用户路径：干净 profile 装一遍、卸一遍，再换一个工作区跑一遍。
2. **静默降级比崩溃更坑。** 崩溃至少知道坏了；降级会让模型信了一个错数据，然后一本正经答错。任何兜底都要在结果里说出来。
3. **每次「修复」都问一句：这是不是回归？** 上面第 1 条坑就是在「修 PATH 依赖」时引入的，之前用 `'node'` 本来是对的。
4. **数据放错位置会被读错因果。** 把「844 轮会话里 9330 个单字句」写进插件介绍，读者会以为插件导致了退化——要先写清是量出来的现象。
5. **给别人用的东西，安装最容易崩。** 让用户手改 profile 的 JSON，少个逗号 DSH 就起不来；能写一键脚本就写。

## 下次开新插件的最小自检

- [ ] `node --check` 语法
- [ ] 功能测试 + 边界测试
- [ ] 干净环境测试（不依赖本机数据，CI 里能过）
- [ ] 扫写死路径（本机绝对路径、盘符、用户名）
- [ ] 模拟 Electron 环境（伪装 `process.execPath`）跑一次
- [ ] 从 GitHub clone 到干净目录再跑一次
- [ ] 空 profile 装 / 卸各一次
- [ ] 输出上限（条数 + 字符）确认生效
- [ ] README：安装 / 卸载 / 排查 / 已知局限，四段齐全

---

这份清单也是这样来的：踩着别人的插件与文档走到今天，能还一点是一点。
有新的坑，欢迎提 PR 补上。
