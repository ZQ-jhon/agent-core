# A2UI frontend (Stage 1)

本目录是 `agent-core` 同一 Git 仓库内的独立前端子工程。本阶段只交付可启动、可构建、可测试的工程骨架，不实现 Schema runtime、业务组件、真实接口、Upload 或 Markdown。

## 运行要求

- Node.js 24 LTS（推荐；兼容范围见 `package.json#engines`）
- pnpm 11.9.0（版本由 `packageManager` 固定）

```bash
cd frontend
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

开发服务器默认地址为 `http://localhost:5173`。

## 验证命令

```bash
pnpm typecheck
pnpm test
pnpm build
```

构建产物输出到 `frontend/dist/`，该目录不提交。

## 目录边界

```text
frontend/
├─ public/          # 原样复制的静态资源；本阶段不包含业务资源
├─ src/
│  ├─ app/          # 应用入口壳；后续页面组合层
│  ├─ test/         # Vitest 全局测试初始化
│  ├─ index.css     # 全局基础样式
│  └─ main.tsx      # React DOM 启动入口
├─ .env.example     # 后续联调环境变量模板
├─ package.json     # 独立前端脚本与依赖
└─ vite.config.ts   # Vite / Vitest 基础配置
```

后续 Stage 应在上述边界内扩展：应用组装放入 `src/app/`；可复用但不含业务语义的代码放入新建的 `src/shared/`；Schema runtime、组件与业务页面的具体目录由对应 Stage 在冻结输入下落地。本阶段不预建空业务目录。

## 前后端隔离与联调入口

- Python 后端继续使用仓库根目录的 `uv`、`pyproject.toml` 和既有启动命令；前端不修改其依赖、启动方式或 API 行为。
- 前后端分别启动，前端当前不会发起网络请求，也未配置代理或虚构接口路径。
- `.env.example` 预留 `VITE_API_BASE_URL`。只有后续 Stage 获得真实接口基址后才复制为 `.env.local` 并赋值；Vite 只会将 `VITE_` 前缀变量暴露给浏览器，因此不得在其中写入密钥。

## 分支方案

Stage 1 由 Multica 在任务专用分支 `agent/agent/24c73f07` 上交付，该分支从 `origin/master` 创建。仓库中没有新仓库或嵌套 `.git`；后续工作从本 PR 合并后的目标分支继续，不另建前端仓库。
