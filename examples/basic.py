"""Example: Agent with search and calculation tools.

To run:
    1. cp .env.example .env   (edit with your API key)
    2. PYTHONPATH="" uv run python examples/basic.py
"""

from dotenv import load_dotenv
load_dotenv()  # 加载 .env 文件中的环境变量

from agent_core import ToolRegistry, run

# ── Define tools ──────────────────────────────────────────────

registry = ToolRegistry()


@registry.register(description="搜索网页获取最新信息")
def web_search(query: str) -> str:
    """MOCK — 替换为真实搜索 API（SerpAPI、Tavily 等）"""
    return (
        f'搜索结果 "{query}"：\n'
        "1. Python 3.13 发布，支持实验性 JIT 编译器\n"
        "2. OpenAI 发布 GPT-5 企业预览版\n"
        "3. TypeScript 6.0 新增 AI 工作流原生类型推断"
    )


@registry.register(description="计算数学表达式，支持加减乘除和幂运算")
def calculate(expression: str) -> str:
    """Evaluate a math expression. Uses Python eval with safety restrictions."""
    # Safety: only allow numbers, operators, parens, spaces
    allowed = set("0123456789+-*/().^ ")
    if not all(c in allowed for c in expression):
        return f"Error: expression contains disallowed characters: {expression}"
    # Replace ^ with ** for exponentiation
    expr = expression.replace("^", "**")
    try:
        result = eval(expr, {"__builtins__": {}})
        return str(result)
    except Exception as e:
        return f"Error evaluating expression: {e}"


# ── Run ───────────────────────────────────────────────────────

if __name__ == "__main__":
    result = run(
        prompt="搜索最新的 Python 版本，然后计算 2026 减 1994 等于多少",
        registry=registry,
        system="你是一个有帮助的助手。使用中文回答。每次只调用一个工具，收到结果后再决定下一步。",
        resume=False,
    )
    print(f"\n{'='*60}")
    print(f"最终回答：\n{result}")
