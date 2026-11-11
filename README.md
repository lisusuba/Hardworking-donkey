<p align="center">
  <img src="./icon.svg" width="96" height="96" alt="donkey-mill icon">
</p>

<h1 align="center">dsh-donkey-mill</h1>

<p align="center">驴拉磨 · 一个会跟着模型吐字速度转圈圈的 DSH Web UI 背景插件<br>
A donkey treadmill background for DeepSeek Harness whose pace tracks the model's live token throughput.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-donkey-mill"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-donkey-mill"></a>
  <a href="./LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

---

## 中文

### 这是什么

`dsh-donkey-mill` 把 DSH Web UI 的背景换成一台「驴拉磨」：一头俯视角度的驴绕着圆形磨盘行走，
模型流式吐字越快，驴和磨盘转得越快；模型空闲时也保持缓慢踱步，不会停死。

两种形态，随时切换：

- **文字** — 中央一个大字「磨」，左侧一个字「驴」沿圆轨公转，磨盘同步自转（楷体优先，安静的水墨感）。
- <img width="1136" height="720" alt="image" src="https://github.com/user-attachments/assets/d619bc29-d996-444d-8796-96621d4e0c05" />
- **动画** — 俯视卡通驴拉磨：四蹄摆动、尾巴拍打、扬起尘土，磨盘随行走进度自转。
- <img width="1214" height="729" alt="image" src="https://github.com/user-attachments/assets/963d6b9f-bb25-498f-aecb-d3ad18a81a4b" />


页面右下角有一个可折叠的控制面板，可以即时切换形态、调节透明度、隐藏整个背景；
所有设置写入 `localStorage`，刷新页面后保留，不需要改配置或重启宿主。

### 安装

**从 npm 安装（推荐，预构建包无需构建授权）：**

```sh
dsh plugin --profile web add dsh-donkey-mill
```

**或直接从 GitHub 安装：**

```sh
# 1. 从 GitHub 安装到你的 profile（示例用 web）
dsh plugin --profile web add github:lisusuba/Hardworking-donkey

# 2. 确认 bundle 层已进入组合配置（应能看到 # == dsh-donkey-mill 层）
dsh --profile web --dump-config
```

然后在 Harness 的 **设置 → 插件（Plugin Manager）** 中确认 `dsh-donkey-mill` 已启用，刷新页面即可看到背景与右下角控制面板。

本地开发目录安装：

```sh
dsh plugin --profile web add /path/to/Hardworking-donkey
```

卸载：

```sh
dsh plugin --profile web remove dsh-donkey-mill
```

### 配置

插件行 id 为 `donkey-mill`，包名为 `dsh-donkey-mill`。bundle 默认配置（`cordis.patch.yml`）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用插件 |
| `mode` | `animated` \| `text` | `animated` | 渲染形态：俯视动画驴 / 汉字 |
| `size` | number (160–720) | `380` | 场景宽度（px），映射到轨道占视口短边的比例 |
| `opacity` | number (0.05–1) | `0.55` | 水印整体不透明度 |
| `showReadout` | boolean | `true` | 是否在底部显示 `N tok/s` 读数 |
| `position` | 字符串枚举 | `bottom-right` | 历史字段，保留兼容但已忽略（场景始终全屏居中） |

> 说明：Web 端当前以**右下角控制面板 + localStorage** 为准（形态 / 透明度 / 显隐）。
> 配置项已在宿主侧声明并通过 schema 校验；在宿主重启后默认值生效，之后以面板设置为准。

### 工作原理

- **宿主半边** (`index.js`)：订阅 `agent/assistant-stream` 事件，按 attempt 维护 EMA 平滑的 token 吞吐
  （综合 `usage` 与 `text-delta`/`reasoning-delta`/`tool-call-delta` 估算），
  通过精确路由 `GET /api/donkey-mill/rate` 暴露 `{"rate": <tok/s>, "active": <bool>}`。
- **Web 半边** (`client.js`)：注册在 `shell.overlay` 槽（`order: -100`，点击穿透），
  每 300ms 轮询速率路由，用 rAF 在单个 SVG 上直接写属性；两种形态共用同一套运动学
  （空闲保底角速度 + tok/s 加速）。零运行时依赖，不需要构建。

### 兼容性

- 仅 Web UI（`platform: "web"`），使用 `shell.overlay` 槽与 `webServer` 精确路由。
- 在 **dsh 0.2.0-rc.2** 上开发与验证。
- 主题色使用 DSH 主题令牌（`--dsw-alias-*`），自动适配亮/暗主题。

### 仓库结构

```
package.json        # bundle 清单（dsh.bundle / dsh.client）
cordis.patch.yml    # Loader patch 层：插入 donkey-mill 行
index.js            # 宿主半边：token 吞吐 → /api/donkey-mill/rate
client.js           # Web 半边：shell.overlay 背景 + 控制面板
icon.svg            # 插件图标
locale/{en,zh}.json # 插件显示名与描述
```

### 许可证

[MIT](./LICENSE) © 2026 lisusuba

---

## English

### What it is

`dsh-donkey-mill` replaces the DSH Web UI background with a "donkey pulling the millstone" scene:
a top-down donkey walks a circular track, and the faster the model streams tokens, the faster the
donkey and millstone spin. When the model is idle it keeps plodding slowly instead of freezing.

Two forms, switchable live:

- **text** — a large 「磨」 (mill) in the centre, a 「驴」 (donkey) orbiting the circular track, and the
  millstone rotating 1:1 with the orbit. Quiet calligraphy feel (KaiTi-first font stack).
- **animated** — a top-down cartoon donkey: swinging legs, flicking tail, kicked-up dust, millstone
  turning as it walks.

A collapsible control panel in the bottom-right corner switches the form, adjusts opacity, or hides the
background. Settings persist in `localStorage`; no config edit or host restart required.

### Install

**From npm (recommended — prebuilt package, no build approval):**

```sh
dsh plugin --profile web add dsh-donkey-mill
```

**Or straight from GitHub:**

```sh
# 1. Install from GitHub into your profile (web shown as an example)
dsh plugin --profile web add github:lisusuba/Hardworking-donkey

# 2. Confirm the bundle layer joined the composed config (look for "# == dsh-donkey-mill")
dsh --profile web --dump-config
```

Then check that `dsh-donkey-mill` is enabled in Harness **Settings → Plugins (Plugin Manager)** and
refresh the page.

From a local checkout:

```sh
dsh plugin --profile web add /path/to/Hardworking-donkey
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-donkey-mill
```

### Configuration

The plugin row id is `donkey-mill` and the package name is `dsh-donkey-mill`. Bundle defaults
(`cordis.patch.yml`):

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable the plugin |
| `mode` | `animated` \| `text` | `animated` | Rendering form: top-down donkey or Chinese characters |
| `size` | number (160–720) | `380` | Scene width (px), mapped to the track's share of the viewport's short side |
| `opacity` | number (0.05–1) | `0.55` | Overall watermark opacity |
| `showReadout` | boolean | `true` | Show the `N tok/s` readout at the bottom |
| `position` | enum | `bottom-right` | Legacy field, accepted but ignored (the scene is always full-viewport centred) |

> On the Web side the **control panel + `localStorage`** are authoritative for form / opacity / visibility.
> The row config is declared and schema-validated on the host; defaults apply after a host restart and the
> panel takes over afterwards.

### How it works

- **Host half** (`index.js`) subscribes to `agent/assistant-stream`, keeps an EMA-smoothed token
  throughput per attempt (combining `usage` with `text-delta` / `reasoning-delta` /
  `tool-call-delta` estimates), and serves it on the exact route
  `GET /api/donkey-mill/rate` as `{"rate": <tok/s>, "active": <bool>}`.
- **Web half** (`client.js`) registers on the `shell.overlay` slot (`order: -100`, click-through),
  polls the rate route every 300 ms, and writes SVG attributes directly from rAF. Both forms share the
  same kinematics (idle plod floor + tok/s acceleration). No runtime dependencies, no build step.

### Compatibility

- Web UI only (`platform: "web"`); uses the `shell.overlay` slot and a `webServer` exact route.
- Developed and verified against **dsh 0.2.0-rc.2**.
- Colours use DSH theme tokens (`--dsw-alias-*`), so light and dark themes both work.

### Repository layout

```
package.json        # bundle manifest (dsh.bundle / dsh.client)
cordis.patch.yml    # Loader patch layer: inserts the donkey-mill row
index.js            # host half: token throughput → /api/donkey-mill/rate
client.js           # web half: shell.overlay background + control panel
icon.svg            # plugin icon
locale/{en,zh}.json # display name and description
```

### License

[MIT](./LICENSE) © 2026 lisusuba
