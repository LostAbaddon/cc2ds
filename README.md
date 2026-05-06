# cc2deepseek

将 Claude Cowork / Anthropic API 请求透明转发到 DeepSeek API 的桥接代理，并自动完成模型名映射。

## 功能

- **透明代理** —— 除模型名映射外，请求体和响应体原样透传
- **模型名映射** —— 自动将 Claude 模型名前缀转换为 DeepSeek 对应模型
- **CORS 全放通** —— 适配浏览器端直接调用
- **健康检查端点** —— `GET /` 或 `GET /health`

## 快速开始

```bash
git clone git@github.com:LostAbaddon/cc2ds.git
cd cc2ds

# 复制并填写配置
cp config.template.json config.json
# 编辑 config.json，填入 DeepSeek API Key

npm start
```

服务默认启动在 `http://127.0.0.1:8764`。

## 配置

`config.json`：

| 字段 | 说明 |
|------|------|
| `server.port` | 监听端口，默认 8764 |
| `server.host` | 监听地址，默认 127.0.0.1 |
| `target.url` | DeepSeek Anthropic 兼容端点 |
| `target.apiKey` | DeepSeek API Key |
| `modelMapping` | 模型名前缀 → 目标模型映射 |
| `logLevel` | 日志级别：debug / info / warn / error |

### 模型映射示例

```json
"modelMapping": [
  { "prefix": "claude-opus",  "target": "deepseek-v4-pro" },
  { "prefix": "claude-sonnet", "target": "deepseek-v4-pro" },
  { "prefix": "claude-haiku",  "target": "deepseek-v4-flash" }
]
```

`claude-opus-4-7-20250805` → `deepseek-v4-pro`
`claude-sonnet-4-6` → `deepseek-v4-pro`
`claude-haiku-4-5-20251001` → `deepseek-v4-flash`
`unknown-model` → `unknown-model`（不匹配则透传）

匹配规则：前缀匹配，按数组顺序优先命中。

## API

所有路径均原样转发至 DeepSeek，并自动修改请求体中的 `model` 字段。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` `/health` | 健康检查 |
| POST | `/v1/messages` | 消息接口 |
| POST | `/v1/messages/count_tokens` | Token 计数 |
| OPTIONS | `*` | CORS 预检 |

健康检查返回示例：

```json
{
  "status": "ok",
  "target": "https://api.deepseek.com/anthropic",
  "mappings": 3
}
```

## 许可

Apache License 2.0 - 详见 [LICENSE](LICENSE)
