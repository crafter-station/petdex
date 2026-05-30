# desktop-windows cherry-pick 进度文档

## 背景

原仓库 (crafter-station/petdex) 的 upstream 已经有了 Windows Tauri v2 桌面端实现，
走的是精简路线：单文件 `lib.rs` + `ui/index.html`（内联 HTML/CSS/JS，无构建步骤）。

Yeedy 的实现更工程化：Vite 前端 + 模块化 Rust（commands/ 目录拆分）。

本次工作是将 yeedy 的功能 cherry-pick 到 upstream 的精简架构中，保留 upstream 的
文件结构（单文件 lib.rs + ui/index.html），但加入 yeedy 的功能。

## 已完成（commit d6889ff）

### 后端 (Rust)

- [x] Cargo.toml 添加所有 yeedy 需要的插件：deep-link, single-instance, fs, process, http
- [x] Cargo.toml 添加依赖：reqwest, tokio
- [x] lib.rs 扩展 setup hook：
  - 自动注册 deep-link 协议
  - 单实例锁（第二个实例触发 focus + 转发 deep link）
  - 目录 bootstrap
  - init-status 检测（未安装时创建 needsInit:true 标记）
  - 自动启动 sidecar
- [x] 新增 Tauri 命令：
  - `read_petdex_data` — 返回宠物列表 + active + 窗口尺寸
  - `set_active` — 切换活动宠物（复制 spritesheet + 写 active.json）
  - `install_pet` — 通过 CLI 安装宠物
  - `set_mascot_state` — 通过 HTTP 向 sidecar 设置状态
  - `trigger_update` — 触发更新
  - `respawn_sidecar` — 重启 sidecar
  - `read_update_info` — 读取更新信息
  - `read_init_status` — 读取初始化状态
  - `asset_url_for` — 返回 asset 文件路径（供 convertFileSrc 使用）
- [x] 保留 upstream 原有命令：list_pets, get_pet, get_active_pet, read_file_as_base64,
  spawn_sidecar, get_sidecar_port, stop_sidecar, quit_app, read_runtime_state,
  read_runtime_bubble

### 前端 (ui/index.html)

- [x] Deep link 监听：`petdex://<slug>` 自动激活/安装宠物
- [x] Init banner：未安装时显示 "Run `npx petdex init` to wire your agents"，点击复制命令
- [x] Update card：轮询更新信息，显示可用更新，点击触发安装
- [x] Sidecar watchdog：每 5 秒 health check，连续失败 3 次自动 respawn
- [x] CSS sprite 动画（9 种状态，upstream 原有）
- [x] 气泡系统（polling read_runtime_bubble）
- [x] 简单拖曳（startDragging）
- [x] 右键退出（stop_sidecar + quit_app）

### 配置

- [x] tauri.conf.json：保持 192x288 窗口尺寸，启用 bundle (msi+nsis)，添加 CSP + assetProtocol
- [x] capabilities/default.json：扩展 fs, http, deep-link, event, path 权限

## 待完成（yeedy 有但 main 还没有）

### 1. 拖曳 + 动量抛掷

**现状**：main 只有 `getCurrentWindow().startDragging()`，靠 OS 原生拖曳。

**目标**：实现 yeedy 的动量物理：
- pointerdown 时记录采样点
- pointermove 时采样速度
- pointerup 时根据速度计算抛掷轨迹
- 动量衰减（friction=0.88）
- 碰撞边界检测（ clamp to visible frame ）
- 抛掷时切换动画状态（running-right / running-left / waving）

**参考文件**：`desktop-windows-yeedy` 分支的 `src/app.js`（第 400-500 行左右的拖曳逻辑）

**实现注意**：
- 需要新增 `zero-native.window.move` 命令（或直接用 Tauri 的 `setPosition`）
- 边界 clamp 需要获取 monitor 信息，可用 `window.__TAURI__.window.availableMonitors()`
- yeedy 里通过 `window.zero.invoke` 调用，main 里直接用 `window.__TAURI__.window.*`

### 2. 宠物选择器菜单

**现状**：main 右键直接退出。

**目标**：右键打开宠物选择菜单（类似 yeedy 的实现）：
- 窗口放大到 480x420（菜单尺寸）
- 虚拟滚动网格（3 列，每行 64px）
- 搜索过滤
- 显示宠物缩略图（通过 asset_url_for + convertFileSrc 加载 spritesheet）
- 点击切换宠物
- 底部 "quit" 按钮（带确认）
- 按 Escape / 点击外部 / blur 关闭菜单

**参考文件**：`desktop-windows-yeedy` 分支的 `src/app.js`（第 500-700 行的菜单逻辑）

**实现注意**：
- 需要 `read_petdex_data` 命令（已实现）获取宠物列表
- 需要 `set_active` 命令（已实现）切换宠物
- 需要 `asset_url_for` + `convertFileSrc` 加载缩略图
- 需要窗口 resize：`getCurrentWindow().setSize({type:'Physical', width, height})`

### 3. 气泡增强（agent avatar）

**现状**：main 气泡是纯文本，通过 `read_runtime_bubble` 获取 text。

**目标**：yeedy 的气泡带 agent avatar：
- bubble.json 包含 `agent_source` 字段
- 显示对应 agent 的 SVG 头像（claude-code, codex, gemini, opencode, fallback）
- 气泡自动定位（靠近宠物上方，超出屏幕时调整宠物位置）

**参考文件**：`desktop-windows-yeedy` 分支的 `src/app.js`（第 200-300 行的气泡逻辑）

**实现注意**：
- 需要 staging agent SVGs 到 `~/.petdex/runtime/webview/agents/`（yeedy 在 Rust setup 里做了这个）
- main 的 `read_runtime_bubble` 已返回完整 JSON，包含 agent_source 的话前端可以直接用
- 需要确认 upstream 的 bubble.json 格式是否包含 agent_source

### 4. asset:// 协议 vs base64

**现状**：main 用 `read_file_as_base64` 把 sprite 读成 base64 data URI。

**目标**：yeedy 用 `asset_url_for` + `convertFileSrc` 生成 `asset://` URL，更高效。

**参考文件**：`desktop-windows-yeedy` 分支的 `src/bridge.js`

**实现注意**：
- `convertFileSrc` 是 Tauri v2 的 API：`window.__TAURI__.core.convertFileSrc(path)`
- 需要确认 assetProtocol 配置已正确（tauri.conf.json 里已配置）
- base64 和 asset URL 可以并存，但 asset URL 更高效

## 参考分支

```bash
# Yeedy 的原始实现（已备份）
git log desktop-windows-yeedy --oneline -- packages/petdex-desktop-windows/

# 关键文件
# - src/app.js — 前端所有逻辑（拖曳、动量、菜单、气泡、deep-link）
# - src/bridge.js — Tauri API 封装（window.zero.invoke）
# - src-tauri/src/commands/ — 模块化命令
# - src-tauri/src/lib.rs — 入口（setup hook、插件初始化）
```

## 开发验证

```bash
# 在 packages/petdex-desktop-windows 目录下
cd packages/petdex-desktop-windows

# 当前 upstream 精简架构没有 package.json / Vite 构建步骤，ui/index.html 直接作为 frontendDist
cd src-tauri

# 静态检查
cargo check

# 构建
cargo build --release
```

如果本机没有 Rust/Cargo，可以手动触发 GitHub Actions 的 `petdex-desktop-windows`
workflow；它会在 Windows runner 上生成 `Cargo.lock`、运行 `cargo check --locked`，
并上传生成后的 lockfile artifact。

**注意**：upstream 的 `tauri.conf.json` 里没有 `beforeDevCommand`/`beforeBuildCommand`，
因为当前保留的是单文件 `ui/index.html`，不需要手动启动 npm dev server。如果后续改回
Vite 前端，再参考 yeedy 的 tauri.conf.json：
```json
"build": {
  "beforeDevCommand": "npm run dev",
  "beforeBuildCommand": "npm run build",
  "devUrl": "http://localhost:1420",
  "frontendDist": "../dist"
}
```

## 窗口尺寸决策

保留 upstream 的 **192x288**（不是 yeedy 的 140x180）。
理由：upstream 已经调优好的尺寸，CSS sprite 动画基于 192x208 的精灵图。
