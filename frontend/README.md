# A2UI frontend

该目录是 `agent-core` 仓库内独立的 React + TypeScript + Vite 前端工程。
应用启动后会从真实后端解析并渲染 A2UI Form Profile v1 表单。

## 运行要求

- Node.js 24 或更高版本（兼容范围见 `package.json#engines`）
- pnpm 11.9.0

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发服务器默认地址为 `http://localhost:5173`。

## API 约定

前端严格使用 `docs/a2ui/v1/http-api-v1.md` 冻结的三个端点：

- `POST /api/a2ui/v1/forms:resolve`
- `POST /api/a2ui/v1/forms/{formId}/submissions`
- `GET /api/a2ui/v1/submissions/{submissionId}`

所有请求均为同源相对路径，不读取 `VITE_API_BASE_URL`，也不在浏览器中保存
共享 Bearer token。后端不可达、返回非契约响应或返回非法 Schema 时，应用会显示
明确错误状态；不会回退到本地 Mock 或 fixture。

## 代码边界

```text
src/
├── a2ui/        # Profile parser、运行时、renderer 与 HTTP API 适配层
├── app/         # 应用加载状态、错误状态与页面组合
├── test/        # Vitest 全局测试初始化
├── index.css    # 全局基础样式
└── main.tsx     # React DOM 入口
```

`src/a2ui/api-client.ts` 只负责冻结 HTTP 契约和传输错误；服务端返回的表单仍须经过
现有严格 parser 后才会进入 renderer。renderer 与 form controller 不自行解析 URL
或发起网络请求。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

构建产物输出到 `dist/`，该目录不提交。
