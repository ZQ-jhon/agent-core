# A2UI Form Profile v1 校验、联动与 Action

## 1. 信任边界

Schema、初始数据、选项和错误消息均按不可信输入处理。前端校验只改善体验，服务端必须使用同一业务约束重新校验。

禁止：

- 执行配置中的 JavaScript、表达式字符串、模板、HTML 或动态 import；
- 直接请求配置下发的 URL、Header、Cookie 或 token；
- 将错误消息作为 HTML 注入；
- 相信扩展名、浏览器 MIME、客户端 hidden/disabled 或客户端校验结果；
- 因未知组件或字段而静默提交不完整数据。

所有 HTTP 目标通过宿主注册表中的 `endpointKey` 解析。注册表负责真实 URL、鉴权、超时上限、CSRF、重试和审计；Schema 永远看不到这些秘密。

## 2. 字段校验

字段通过 `validation` 数组声明同步 validator，按数组顺序执行。默认每字段展示第一个错误，Form 错误摘要可列出全部字段的首个错误。

| validator | 适用值 | 参数 | 默认错误码 |
| --- | --- | --- | --- |
| `required` | 全部输入 | 无 | `FIELD_REQUIRED` |
| `minLength` / `maxLength` | string | 非负整数 `value` | `STRING_TOO_SHORT` / `STRING_TOO_LONG` |
| `pattern` | string | RE2 兼容模式 `value` | `PATTERN_MISMATCH` |
| `minimum` / `maximum` | number | number `value` | `NUMBER_TOO_SMALL` / `NUMBER_TOO_LARGE` |
| `integer` | number | 无 | `INTEGER_REQUIRED` |
| `minItems` / `maxItems` | array | 非负整数 `value` | `ARRAY_TOO_SHORT` / `ARRAY_TOO_LONG` |

每个 validator 可提供纯文本 `message` 和大写下划线 `code`。省略时 renderer 使用本地化默认文案和上表默认码。

### 2.1 required 语义

- `null`、`undefined`、空字符串（trim 后）和空数组视为空；
- `0` 与 `false` 是有效值；
- hidden 或 disabled 字段跳过客户端 required，但服务端根据提交时的业务状态决定是否必填；
- Upload 只有至少一个 `status: "uploaded"` 的文件时才满足 required。

### 2.2 pattern 安全子集

v1 接受 RE2 兼容正则，模式最长 256 字符。生产者和服务端拒绝反向引用、lookaround、递归、条件分支及宿主实现不一致的扩展。renderer 必须限制单次匹配输入长度，不得执行由配置构造的替换代码。

### 2.3 执行时机

- change：仅更新值和联动，不默认显示新错误；
- blur：校验当前字段；
- submit：校验全部可见且启用字段，失败则阻止 action；
- server response：服务端 `fieldErrors` 覆盖同一路径的旧服务端错误；用户修改该路径后可清除该路径的服务端错误。

## 3. 条件表达式白名单

条件必须是结构化 AST，不能是字符串：

```json
{
  "op": "and",
  "args": [
    { "op": "equals", "path": "/identity/personType", "value": "contractor" },
    { "op": "not", "arg": { "op": "isEmpty", "path": "/identity/workEmail" } }
  ]
}
```

允许的 op：

| op | 结构 | 语义 |
| --- | --- | --- |
| `equals` / `notEquals` | `path`, `value` | JSON 标量或数组的深度相等/不等；不做字符串转数字。 |
| `greaterThan` / `greaterThanOrEqual` | `path`, `value` | 两侧都为 number 或 ISO 日期字符串时比较。 |
| `lessThan` / `lessThanOrEqual` | `path`, `value` | 同上。 |
| `in` / `notIn` | `path`, `value` | `value` 必须是数组，判断 path 值是否在其中。 |
| `exists` | `path` | path 可解析且值不是 `undefined`；null 仍算存在。 |
| `isEmpty` | `path` | required 语义下为空。 |
| `and` / `or` | `args` | 1..20 个子条件，短路求值。 |
| `not` | `arg` | 对单个子条件取反。 |

限制：条件深度最多 10 层，总节点最多 100 个。路径解析失败视为 `false` 并记录 `RULE_PATH_NOT_FOUND` 警告；不会抛出到页面顶层。

## 4. 联动规则

```json
{
  "id": "show-company",
  "event": "change",
  "sourceDataPath": "/identity/personType",
  "when": {
    "op": "equals",
    "path": "/identity/personType",
    "value": "contractor"
  },
  "then": [
    { "type": "setVisible", "targetComponentId": "company", "value": true },
    { "type": "setDisabled", "targetComponentId": "company", "value": false }
  ],
  "else": [
    { "type": "setVisible", "targetComponentId": "company", "value": false },
    { "type": "setValue", "targetDataPath": "/identity/companyName", "value": null }
  ]
}
```

v1 仅支持：

- `setVisible(targetComponentId, boolean)`；
- `setDisabled(targetComponentId, boolean)`；
- `setValue(targetDataPath, JsonValue)`。

规则只响应精确匹配的 `sourceDataPath` change 事件。执行顺序为文档顺序，同一次事件每条规则最多一次；完成本批 effects 后统一渲染。`setValue` 产生的新 change 可进入下一批，但整条依赖图必须无环，单次用户操作最多 20 批，超限则停止并报告 `RULE_EXECUTION_LIMIT`。

初次加载以 `initialValues` 为输入执行一次全部规则，用于统一首屏 visible/disabled 状态。重置后重复该过程。

不支持：动态 required、动态 validator、任意计算、字符串拼接、日期运算、网络请求或创建/删除组件。确有需求时由服务端生成新 revision。

## 5. Action

组件的 `action.actionId` 必须引用顶层 `actions`。v1 只允许三类。

### 5.1 submit

```json
{
  "id": "submit-trip",
  "type": "submit",
  "endpointKey": "forms.submit",
  "method": "POST",
  "timeoutMs": 15000
}
```

执行顺序：确认对话框（若配置）→ 客户端同步校验 → 防重复锁 → 构造提交包络 → 宿主解析 endpoint → 发送 → 映射响应 → 解锁。

同一 action 在请求未结束时不能由同一 renderer 重复触发。网络错误、超时或响应丢失后的自动/人工重试必须遵循以下幂等契约：

1. 客户端在首次发送前为一次**逻辑提交**生成必填 `idempotencyKey`，并保存到收到终态响应；同一逻辑提交的所有重试复用该 key，`requestId` 仅标识每次传输链路。用户修改数据、选择另一 submit action 或明确发起新提交时必须生成新 key。
2. key 的服务端作用域固定为“认证主体 + `formId` + `revision` + `action.actionId`”。不同认证主体之间不得共享幂等记录，`sourceComponentId` 进入请求指纹但不扩大作用域。
3. 规范化请求是严格模型解析后的 `{schemaVersion, formId, revision, action, data}`。对象键递归按 Unicode 码点排序，数组顺序保留，字符串保持原值，数字使用 JSON 最短十进制表示，序列化不含无意义空白；`requestId`、`idempotencyKey` 和展示提示 `client` 不进入指纹。
4. 服务端必须在执行任何业务副作用前原子创建或读取 `(scope, idempotencyKey)` 记录，并保存规范化请求指纹。记录不存在时仅一个执行者可取得所有权；同 key、同指纹的并发请求不得重复执行副作用。
5. 已有同 key、同指纹且已完成的记录直接回放已持久化的 HTTP 状态和响应体。成功回放的 `submissionId` 必须与首次响应相同，`result` 必须 JSON 深度等价；响应中的 `requestId` 可以回显当前重试请求，且不影响业务结果等价性。
6. 已有同 key 但指纹不同返回 HTTP `409`、`IDEMPOTENCY_CONFLICT`、`retryable: false`，不得覆盖记录或执行 action。已有同 key、同指纹但仍在处理时返回 HTTP `409`、`SUBMISSION_IN_PROGRESS`、`retryable: true`；客户端稍后仍使用同一 key 重试。
7. 业务写入与成功结果/`submissionId` 的幂等记录必须在同一原子事务中提交；若副作用位于外部系统，适配器必须使用同一业务幂等键或事务 outbox，保证崩溃恢复后可重建并回放唯一结果。未发生副作用的可重试基础设施错误不得永久固化为成功记录。

### 5.2 reset

```json
{ "id": "reset-form", "type": "reset" }
```

本地操作，不请求网络。恢复 `initialValues`、清除 touched/dirty/loading 和客户端/服务端字段错误，然后重新计算联动规则。上传文件的服务器清理由宿主业务负责；reset 不能假设已删除远程文件。

### 5.3 upload

```json
{
  "id": "upload-file",
  "type": "upload",
  "endpointKey": "files.upload",
  "method": "POST",
  "fieldName": "file",
  "timeoutMs": 30000
}
```

宿主以 multipart/form-data 上传一个文件，成功响应必须至少包含 `fileId`、`name`、`size`、`mimeType`。只有成功响应才写入 `UploadValue[]`。上传失败不产生表单值。

客户端限制只用于提前提示。服务端必须重新校验配额、大小、内容类型、恶意内容和访问权限，并确保提交者只能引用自己有权使用的 `fileId`。

## 6. 远程选项数据源

```json
{
  "id": "cities-source",
  "type": "remoteOptions",
  "endpointKey": "locations.cities",
  "method": "GET",
  "query": [
    {
      "name": "countryCode",
      "source": { "kind": "data", "path": "/destination/countryCode" }
    },
    { "name": "q", "source": { "kind": "searchText" } }
  ],
  "response": {
    "itemsPath": "/items",
    "labelPath": "/name",
    "valuePath": "/id",
    "disabledPath": "/disabled"
  },
  "dependsOn": ["/destination/countryCode"],
  "debounceMs": 300,
  "minQueryLength": 2,
  "cacheTtlSeconds": 300
}
```

query source：

- `data`：读取表单 dataPath；
- `searchText`：读取当前 Select 的搜索文本；
- `literal`：使用 Schema 中的标量常量。

响应映射：`itemsPath` 相对响应根，其他 path 相对单个 item。`label` 转为 string；`value` 只接受 string/number/boolean；无效项丢弃并记录警告。结果去重后最多接收宿主设定的条数。

行为：

- 未满足 `dependsOn` 或 `minQueryLength` 时不发请求；
- 查询参数改变时取消/忽略旧请求，只有最新请求可更新选项；
- 缓存 key 由 endpointKey 和规范化参数构成，不跨认证主体共享；
- 加载、空结果和失败必须有可见状态；失败可重试但不能把错误当作空结果；
- 若当前已选 value 不在新列表中，清为 null 并触发正常 change 联动；
- endpointKey 未注册时显示组件级错误并禁止提交依赖该值的表单。

## 7. 错误与降级矩阵

| 场景 | 级别 | 客户端行为 | 上报码 |
| --- | --- | --- | --- |
| JSON 不可解析、顶层缺字段 | 致命 | 不渲染，显示协议错误页 | `SCHEMA_INVALID` |
| 不支持的 schemaVersion | 致命 | 不渲染，提供刷新/升级提示 | `SCHEMA_VERSION_UNSUPPORTED` |
| root 不是 Form、ID 重复、引用悬空 | 致命 | 不执行任何 action 或数据源 | `SCHEMA_SEMANTIC_INVALID` |
| 未知根/核心组件 | 致命 | 不渲染 | `COMPONENT_UNSUPPORTED` |
| 未知非关键子组件绕过校验到达 renderer | 局部 | 显示含 componentId 的占位，不渲染其 children | `COMPONENT_UNSUPPORTED` |
| 单个已知组件渲染异常 | 局部 | ErrorBoundary 占位，其余表单继续 | `COMPONENT_RENDER_FAILED` |
| dataPath 缺失/类型不符 | 字段 | 禁用字段并显示配置错误；禁止提交 | `DATA_BINDING_INVALID` |
| 规则路径或目标无效 | 局部/致命 | 加载前检查到则拒绝；运行时停止该规则 | `RULE_INVALID` |
| 远程选项失败 | 字段 | 保留可重试错误，不伪装为空结果 | `DATA_SOURCE_FAILED` |
| submit 网络失败 | 表单 | 保留用户数据，解除 loading，允许安全重试 | `ACTION_FAILED` |
| 服务端 fieldError 无法映射 | 表单 | 放入错误摘要，不丢弃 | `FIELD_ERROR_UNMAPPED` |

错误消息对用户使用纯文本、可行动描述；诊断详情写入日志，不在生产 UI 暴露堆栈、内部 URL、查询或敏感数据。

## 8. 服务端复核清单

提交处理必须按顺序检查：认证/权限 → 包络/版本 → formId/revision → action/source 绑定 → 幂等作用域与规范化指纹 → 原子登记/回放判定 → 数据类型与允许路径 → 字段 validator → 远程 option 合法性 → 上传文件所有权 → 业务校验 → 原子业务写入与结果持久化。

服务端不得把客户端未声明的数据键自动透传到持久层。建议以当前 revision 的字段白名单投影提交数据，对未知键返回 `REQUEST_INVALID` 或显式忽略并记录安全事件；本项目 v1 采用“拒绝未知键”。
