# Petdex Win — 验收状态报告

> 生成日期：2026-05-16
> 验收范围：节点 1~4（合并验收）
> 验收方式：静态代码审查 + 最小修复（未做动态编译验证）

---

## 1. 总体状态

| 维度 | 状态 | 说明 |
|------|------|------|
| 项目骨架 | ✅ 完成 | Tauri 项目结构完整，配置到位 |
| 前端提取 | ✅ 完成 | HTML/CSS/JS/Bridge 均从 main.zig 提取并就位 |
| CSP 安全 | ✅ 通过 | 无 `onclick=` / `onload=` / `eval` / `innerHTML +=` |
| 核心功能 | ⚠️ 越界 | cowork 实际实现了节点 2~4 大部分功能，但未经编译验证 |
| 编译验证 | ❌ 阻塞 | 本机无 Rust + MSVC Build Tools，未做 `cargo check` |
| 动态验收 | ❌ 未做 | 需要编译通过后，在浏览器 DevTools 中逐项验证 |

---

## 2. 已修复（本次会话）

### C2 — 不存在 npm 依赖
- **问题**：`@tauri-apps/plugin-single-instance@^2.0.0` 在 npm registry 404（该插件是 Rust-only，无 JS 包）
- **修复**：从 `package.json` dependencies 中移除
- **文件**：[`package.json`](package.json)

### H1 — pet.json schema 错位
- **问题**：`pets.rs` 读 `json["name"]` / `json["author"]`，但 R2 真实 pet.json 字段是 `displayName`，且无 `author`
- **修复**：改读 `displayName`，缺失时 fallback 用 slug；删除 `author` 字段
- **文件**：[`src-tauri/src/pets.rs`](src-tauri/src/pets.rs)

### H2 — 首次启动宠物黑屏
- **问题**：`stage_webview_assets` 把 sprite 写到 `webview/<slug>/` 子目录，但 `app.js` 首次加载调 `assetUrlFor('spritesheet.webp')` 找的是顶层路径，文件不存在
- **修复**：`stage_webview_assets` 末尾把 active pet 的 sprite 复制到 `webview/` 顶层
- **文件**：[`src-tauri/src/pets.rs`](src-tauri/src/pets.rs)

### H6 — init banner 永远不显示
- **问题**：`read_init_status` 读 `init-status.json`，文件不存在时 fallback `{"needsInit": false}`，导致首次启动 banner 不触发
- **修复**：`lib.rs` `setup` 阶段检测：若 sidecar 和 CLI 都不存在，主动写 `{"needsInit": true}`
- **文件**：[`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)

---

## 3. 待修复（编译后才能验证）

### H3 — asset_url_for 路径遍历
- **问题**：`assets.rs` 直接 `webview_dir.join(name)`，未校验 `name` 是否包含 `..`
- **影响**：节点 5 测试矩阵要求"路径遍历返回 invalid_slug"
- **文件**：[`src-tauri/src/commands/assets.rs`](src-tauri/src/commands/assets.rs)

### H4 — CSP 阻 sidecar fetch
- **问题**：`default-src 'self'` 未声明 `connect-src`，前端 `fetch('http://127.0.0.1:7777/health')` 会被 CSP 阻断
- **影响**：节点 4 验收第 2 项"sidecar 崩溃后自动 respawn"失败
- **修复方向**：CSP 加 `connect-src 'self' http://127.0.0.1:7777`，或改走 Rust 侧 probe
- **文件**：[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)

### H5 — 拖拽未用 startDragging
- **问题**：bridge.js 每次 mousemove 调 `setPosition`，~60Hz IPC 往返，不顺滑
- **影响**：节点 3 拖拽体验
- **修复方向**：`pointerdown` 时调 `appWindow.startDragging()`，让 OS 接管；松手后算速度做动量
- **文件**：[`src/bridge.js`](src/bridge.js)、[`src/app.js`](src/app.js)

### M1/M2 — 死配置和冗余 CSP
- **问题**：capabilities 列了大量未使用的 permission；CSP 同时保留 `asset:`（v1 残留）和 `http://asset.localhost`（v2 实际使用）
- **影响**：不阻塞功能，增加噪音
- **文件**：[`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json)、[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)

---

## 4. 硬阻塞（必须解决才能验收）

### C1 — 本机无 Tauri 编译环境
- **缺失**：Rust 工具链（`cargo`/`rustc`/`rustup` not found）
- **缺失**：MSVC Build Tools（`cl.exe` not found，VS 目录不存在）
- **本机方案**：
  - VS Build Tools 2022 + "Desktop development with C++"（~3~6GB）
  - `rustup-init` 装默认 toolchain（~1GB）
- **替代方案**：
  - 去另一台有 Rust + MSVC 的机器跑 `npm run tauri dev`
  - 配 GitHub Actions workflow，云端 `cargo check`/`cargo build`

---

## 5. 测试数据

已准备一只 pet 在本地：

```
C:/Users/lenovo/.codex/pets/sabo/
├── pet.json          (221B, 含 displayName: "Sabo")
└── spritesheet.webp  (2.0MB)
```

来源：从 `https://petdex.crafter.run/api/manifest` 拿到 slug `sabo` 的 R2 URL，curl 手动下载并重命名。

> 注：R2 原始文件是 `sprite.webp` 和 `petjson.json`，win 端期待 `spritesheet.webp` 和 `pet.json`，已手动重命名对齐。

---

## 6. 验收清单逐项状态

### 节点 1（5 项）

| # | 验收项 | 状态 | 备注 |
|---|--------|------|------|
| 1 | `npm run tauri dev` 启动透明无边框窗口 | ❌ 未验证 | 需编译环境 |
| 2 | DevTools Console 无 CSP 报错 | ❌ 未验证 | 需编译环境 |
| 3 | `window.__PETDEX__` 非空，`compactWidth` 有值 | ❌ 未验证 | 需编译环境 |
| 4 | `window.zero.invoke('petdex.read_petdex_data')` 返回宠物列表 | ❌ 未验证 | 需编译环境 |
| 5 | 宠物缩略图通过 `convertFileSrc` 正确加载 | ❌ 未验证 | 需编译环境；H2 修复后理论上首次启动也有图 |

### 节点 2（5 项）

| # | 验收项 | 状态 | 备注 |
|---|--------|------|------|
| 1 | 启动后显示默认宠物 idle 动画 | ❌ 未验证 | 需编译环境 |
| 2 | POST /state 能驱动动画切换 | ❌ 未验证 | 需 sidecar 运行 |
| 3 | 切回 idle 正常 | ❌ 未验证 | 需 sidecar 运行 |
| 4 | Bridge 返回值是对象不是字符串 | ❌ 未验证 | 需编译环境 |
| 5 | `set_active` 切换宠物正确显示 | ❌ 未验证 | 需编译环境 |

### 节点 3（6 项）

| # | 验收项 | 状态 | 备注 |
|---|--------|------|------|
| 1 | 拖拽 + 惯性滑动 | ❌ 未验证 | H5 未修，体验可能不佳 |
| 2 | 多显示器边界 clamp | ❌ 未验证 | 需编译环境 |
| 3 | 点击宠物打开菜单，窗口扩到 480×420 | ❌ 未验证 | 需编译环境 |
| 4 | 菜单选其他宠物，缩回 140×180 | ❌ 未验证 | 需编译环境 |
| 5 | click-through（宠物周围桌面可点击） | ❌ 未验证 | 需编译环境 |
| 6 | 右键菜单 Quit 退出 | ❌ 未验证 | 需编译环境 |

### 节点 4（6 项）

| # | 验收项 | 状态 | 备注 |
|---|--------|------|------|
| 1 | Claude Code 工具调用时气泡显示 | ❌ 未验证 | 需 sidecar + hooks |
| 2 | sidecar 崩溃后自动 respawn | ❌ 未验证 | H4 未修，CSP 会阻断 probe fetch |
| 3 | deep-link 冷启动（`petdex://aurora`） | ❌ 未验证 | 需编译环境 |
| 4 | deep-link 热启动（应用已运行时响应） | ❌ 未验证 | 需编译环境 |
| 5 | 更新可用时底部显示更新卡片 | ❌ 未验证 | 需编译环境 |
| 6 | `petdex init` 未运行时显示 init banner | ⚠️ 半验证 | H6 已修，静态逻辑通，动态未跑 |

---

## 7. 文件变更清单（本次会话）

```
 petdex-win/
 ├── package.json                         (-) 移除 @tauri-apps/plugin-single-instance
 ├── src-tauri/src/pets.rs                (M) H1: schema 修复；H2: 首次启动 sprite 复制
 ├── src-tauri/src/lib.rs                 (M) H6: init banner 触发逻辑
 └── ACCEPTANCE.md                        (+) 本文档
```

---

## 8. 下一步行动（选一个）

| 选项 | 动作 | 预估时间 |
|------|------|---------|
| A | 在有 Rust + MSVC 的机器上 `npm install && npm run tauri dev`，逐项跑 DevTools 验收 | 10~20 分钟（首次编译 5~10 分钟） |
| B | 配 GitHub Actions workflow，云端 `cargo check` + `cargo build` | 15 分钟写 workflow |
| C | 继续修 H3/H4/H5，修完再走验收 | 30~60 分钟 |
| D | 先搁置，有空了从"安装编译环境"重新开始 | 视机器空间而定 |

---

*本文档随代码一起维护，每次验收后更新状态列。*
