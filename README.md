# DeepSeek-Claude Proxy

DeepSeek API → Claude Code 转换代理

## 部署到 Render

1. Fork 这个仓库
2. 在 Render 创建 Web Service
3. 设置环境变量:
   - `DEEPSEEK_API_KEY`: 你的 DeepSeek API key
   - `DEEPSEEK_MODEL`: deepseek-chat (默认)
4. 部署后获取 URL: `https://xxx.onrender.com`

## 配置 Claude Code

```bash
# Windows
$env:ANTHROPIC_BASE_URL="https://xxx.onrender.com"
$env:ANTHROPIC_API_KEY="any-value"

# Linux/Mac
export ANTHROPIC_BASE_URL="https://xxx.onrender.com"
export ANTHROPIC_API_KEY="any-value"
```

然后直接使用 `claude` 命令即可。
