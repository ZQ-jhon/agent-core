# A2UI Form Profile v1

Route-level API, generated OpenAPI, observability, and local verification:
[`http-api-v1.md`](http-api-v1.md).

Frontend preparation and the versioned backend handoff:
[`frontend-integration-handoff-v1.md`](frontend-integration-handoff-v1.md).

项目本地的安全动态表单契约。阅读顺序：

1. [`schema-v1.md`](schema-v1.md)：范围、版本、包络、数据绑定和 HTTP 契约；
2. [`component-catalog-v1.md`](component-catalog-v1.md)：组件 props、默认值、数据与无障碍要求；
3. [`validation-and-actions-v1.md`](validation-and-actions-v1.md)：校验、联动、action、数据源和降级；
4. [`form-examples-v1.json`](form-examples-v1.json)：单字段修改、条件化资料补全、含远程选项的必要约束申请三个可渲染标准示例；
5. [`backend-contract-review-v1.md`](backend-contract-review-v1.md)：后端对齐与冻结记录。
6. [`frontend-visual-interaction-spec-v1.md`](frontend-visual-interaction-spec-v1.md)：前端演示页视觉、交互、组件状态与 QA 验收基线。

机器可读文件：

- [`schema/a2ui-form-v1.schema.json`](schema/a2ui-form-v1.schema.json)
- [`schema/a2ui-api-v1.schema.json`](schema/a2ui-api-v1.schema.json)
- [`types/a2ui-form-v1.ts`](types/a2ui-form-v1.ts)

验证：

```bash
uv run --extra dev pytest tests/test_a2ui_contract_v1.py
```

本 Profile 不是官方 A2UI v1.0 Candidate 的线级兼容实现；完整关系见 `schema-v1.md`。
