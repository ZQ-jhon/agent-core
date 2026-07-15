# agent-core

**一个不到 70 行的 Agent 核心循环。不依赖任何框架，只用 Python。**  
每条代码你都能看懂，每个步骤你都能 print 出来调试。

---

## 这是什么

如果你用过 ChatGPT，你知道你问一句它答一句。Agent 的区别在于：**它能自己调用工具**。

比如你问「帮我查一下今天的天气，如果是晴天就帮我创建明天的晨跑日历」，Agent 会：
1. 调用天气查询工具 → 知道是晴天
2. 调用日历工具 → 创建事件
3. 把结果告诉你

这个项目就是那根让模型能自己调工具的「骨架」。它只有 70 行核心代码，剩下的全是注释和例子。

---

## 前置条件

你电脑上要有 **Python 3.10 或以上**。检查方法：

```bash
python --version
# 输出类似 Python 3.11.x 就对了
```

如果没有，去 [python.org](https://python.org) 下载安装。

还需要 **uv**（Python 包管理器）：

```bash
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 装完重启终端，然后验证
uv --version
```

---

## 5 分钟跑起来

### 1. 进入项目目录

```bash
cd D:\project\agent-core
```

### 2. 配置 API

复制配置文件，然后编辑它：

```bash
copy .env.example .env
```

打开 `.env`，填上你的 API 信息。这三个字段必须填：

```bash
# 必填：API 地址
OPENAI_BASE_URL=https://api.openai.com/v1

# 必填：API 密钥
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx

# 必填：模型名称
OPENAI_MODEL=gpt-4o
```

### 3. 安装依赖

```bash
uv sync
```

这一步会自动安装 `openai` 和 `pydantic` 两个依赖包，大约 10 秒。

### 4. 运行示例

```bash
PYTHONPATH="" uv run python examples/basic.py
```

你应该会看到类似这样的输出：

```
── Step 1 ──
→ web_search({"query": "latest Python version"})
← Search results for "latest Python version": ...

── Step 2 ──
→ calculate({"expression": "2026 - 1994"})
← 32

── Step 3 ──
Done: 最新 Python 版本是 3.13，2026 减 1994 等于 32。
```

> **注意：** 命令前面的 `PYTHONPATH=""` 是因为本机 Hermes 的环境变量有冲突，运行这个项目时必须加。后续可以写到脚本里。

---

## 怎么用（从简单到复杂）

### 场景 1：加上你自己的工具

打开 `examples/basic.py`，在 `registry` 下面加：

```python
@registry.register(description="获取当前时间")
def get_current_time() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
```

不需要写 JSON Schema —— 装饰器会从函数签名自动生成。`description` 里的文字会告诉模型这个工具是干什么的。

然后改 prompt：

```python
result = run(
    prompt="现在几点了？",
    registry=registry,
)
```

### 场景 2：接你自己的业务系统

```python
@registry.register(description="查询用户订单状态")
def query_order(order_id: str) -> str:
    # 这里调你自己的数据库或 API
    orders = {"ORD001": "已发货", "ORD002": "待支付"}
    return orders.get(order_id, "未找到该订单")
```

Agent 会自动判断什么时候该调这个工具。

### 场景 3：从中断处恢复

Agent 每一步都会自动保存到 `checkpoints/` 目录。如果中途挂了：

```python
result = run(
    prompt="...",
    registry=registry,
    resume=True,  # ← 从上次断点继续
)
```

---

## API 供应商支持

因为直接用的 OpenAI SDK，**所有兼容 OpenAI 接口格式的供应商都能用**。只需要改 `.env` 里的三个字段：

| 供应商 | OPENAI_BASE_URL | OPENAI_MODEL 示例 | 备注 |
|--------|----------------|-------------------|------|
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o` | 官方，质量最高 |
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-chat` | 性价比高，中文好 |
| **Anthropic** | 需通过兼容代理 | `claude-sonnet-4-20250514` | 需代理转换层 |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o` | 聚合平台，一个 key 调多家 |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.1-70b-versatile` | 速度快（LPU 推理） |
| **Together AI** | `https://api.together.xyz/v1` | `meta-llama/Llama-3.1-70B` | 开源模型托管 |
| **Ollama（本地）** | `http://localhost:11434/v1` | `qwen2.5:7b` | 免费，本地跑，数据不出本机 |
| **通义千问** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 阿里云 |
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4` | 国内，中文好 |
| **Moonshot** | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 长上下文 |
| **硅基流动** | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` | 国内聚合平台 |

**你目前在 Hermes 里用的是 DeepSeek v4**，所以你的 `.env` 应该这样填：

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-你的deepseek-key
OPENAI_MODEL=deepseek-chat
```

---

## 项目结构 —— 每个文件干什么

```
agent-core/
├── pyproject.toml          # 项目配置：名称、Python 版本、依赖包
├── .env.example            # API 配置模板，复制为 .env 使用
├── .gitignore              # 告诉 git 忽略哪些文件
│
├── src/agent_core/         # 源代码（核心）
│   ├── core.py             # ★ 主角 —— agent 循环，只有 70 行
│   ├── tools.py            # 工具注册器 —— 用装饰器定义工具
│   ├── checkpoint.py       # 进度保存 —— 存到 JSON 文件
│   └── types.py            # 数据类型 —— Message、AgentState
│
├── examples/
│   └── basic.py            # 示例：带搜索和计算工具的 Agent
│
└── tests/
    └── test_agent.py       # 自动化测试（8 个，全通过）
```

### 核心循环图解

```
用户提问
    ↓
┌─────────────────────────────┐
│  while 还没结束:             │
│                              │
│  ① 把当前消息发给模型         │
│  ② 模型回复："我要调工具X"    │
│  ③ 执行工具X，拿到结果        │
│  ④ 保存进度到 checkpoints/   │
│  ⑤ 把结果追加到消息列表       │
│  ⑥ 回到①                    │
│                              │
│  …或者模型回复："结束了"      │
└─────────────────────────────┘
    ↓
返回最终答案
```

### core.py 对照阅读

如果你看 `src/agent_core/core.py`，整个 agent 循环就是这一段：

```python
while state.step < max_steps:           # 防止死循环
    response = client.chat.completions.create(
        model=model,
        messages=[...],                  # 聊天记录
        tools=tools,                     # 可用工具列表
    )

    if finish_reason == "stop":          # 模型说完了
        return content

    if tool_calls:                       # 模型要调工具
        result = registry.execute(...)    # 执行工具
        messages.append(result)           # 把结果告诉模型
        save_checkpoint(state)            # 存档
        continue                          # 继续循环
```

---

## 常见问题

### Q: 运行报 `PYTHONPATH` 相关错误？
A: 命令前加 `PYTHONPATH=""`。这是本机 Hermes 的环境变量冲突，不影响项目本身。

### Q: 运行报 API 连接错误？
A: 检查三件事：
1. `.env` 文件是否存在
2. `OPENAI_API_KEY` 是否正确
3. 是否需要代理（如果在本机，确认 Clash 开着）

### Q: 怎么换模型？
A: 改 `.env` 里的 `OPENAI_MODEL`，比如改成 `deepseek-chat`、`gpt-4o-mini`。

### Q: Agent 卡住了怎么办？
A: 默认最多跑 20 步自动停止。如果你想改，在 `run()` 里传 `max_steps=50`。

### Q: 项目需要 Python 基础吗？
A: 用的话不需要 —— 改 `.env` 和 `examples/basic.py` 里的工具就行。看源码的话，70 行核心代码，有 TypeScript/JavaScript 基础足够看懂。

---

## 运行测试

```bash
PYTHONPATH="" uv run pytest tests/ -v
```

当前 8 个测试全部通过。

---

## 技术选型说明

本项目故意**不用**任何 Agent 框架（LangChain、CrewAI、Mastra 等），原因：

| 框架方式的代价 | 原生方式的好处 |
|---------------|---------------|
| 出问题要翻框架源码 | 出问题就 70 行，一眼定位 |
| 框架升级可能 breaking | 依赖只有 openai + pydantic，十年不变 |
| 新人要学框架概念（Graph/Node/Edge） | 新人只需要看懂 while + if |
| 框架绑定特定生态 | 换模型 = 改环境变量 |
