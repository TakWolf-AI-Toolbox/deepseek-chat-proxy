# DeepSeek Chat Proxy

通过 Chrome 扩展模拟用户操作，实现免费使用网页版 DeepSeek Chat（https://chat.deepseek.com/）。

## 架构

```
CLI (HTTP POST /api/chat/stream)
        ↓
代理服务器（端口 12500）
        ↓
Chrome Extension (background.js) ←→ Chrome Extension (content.js)
        ↓                                    ↓
CLI 接收 SSE 流式响应              DeepSeek 网页（chat.deepseek.com）
```

## 组件

### Chrome 扩展

**background.js（Service Worker）**
- 与代理服务器建立 WebSocket 连接
- 接收服务器转发的 `send_message` 指令
- 通过 `chrome.tabs.sendMessage` 将消息发往 content.js
- 接收 content.js 上报的 `stream_chunk` 和 `error` 消息，转发给服务器

**content.js（Content Script）**
- 注入到 DeepSeek 页面
- 通过 `chrome.runtime.sendMessage` 与 background.js 双向通信
- 填充 textarea、触发发送
- 用 `MutationObserver` 监听 DOM 变化，捕获 AI 流式响应
- 将响应切片通过 `chrome.runtime.sendMessage` 回传

### 代理服务器

- HTTP 接口（`POST /api/chat/stream`）接收 CLI 请求，返回 SSE 流式响应
- WebSocket 服务器（端口 12500）连接扩展
- 按标签页管理 Session（Map<sessionId, Session>）
- 转发 CLI 消息到对应 Session 的扩展
- 转发扩展响应到 CLI

### CLI 工具

- HTTP 客户端
- 发送用户消息（`POST /api/chat/stream`），接收 AI 响应（SSE 流式）
- 支持多轮对话（通过 sessionId 维持会话上下文）
- **Agent 模式**：新对话时自动注入工具上下文，支持执行命令、读取文件、列出目录
- 工具调用采用 `<<tool_call>>tool_name|args<</tool_call>>` 格式

## 快速开始

### 1. 安装依赖

```bash
cd proxy-server && npm install
cd ../cli && npm install
```

### 2. 启动代理服务器

```bash
cd proxy-server && npm start
```

### 3. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/` 目录

### 4. 打开 DeepSeek 网页

在 Chrome 中访问 https://chat.deepseek.com/，确保扩展已成功注入。

### 5. 启动 CLI

```bash
cd cli && npm start
```

CLI 命令：
- `quit` — 退出
- `clear` — 重置会话
- `session` — 查看当前 sessionId

## Agent 模式

CLI 内置 Agent 能力，可以执行命令和访问文件系统。

### 可用工具

| 工具 | 说明 | 示例 |
|------|------|------|
| `execute` | 执行 shell 命令 | `<<tool_call>>execute\|ls -la /tmp<</tool_call>>` |
| `read_file` | 读取文件内容 | `<<tool_call>>read_file\|/etc/hosts<</tool_call>>` |
| `ls` | 列出目录内容 | `<<tool_call>>ls\|/tmp<</tool_call>>` |

### 工作原理

1. 新对话时，CLI 自动在第一条消息前注入 Agent 上下文
2. AI 响应中的工具调用会被解析执行
3. 执行结果作为新消息发送，AI 继续响应
4. 最多迭代 10 轮

## API

### HTTP

#### `POST /api/chat/stream`

发送消息，接收流式响应。

**Request Body**
```json
{
  "sessionId": "new | <sessionId>",
  "message": "用户输入的文字"
}
```

**Response** (SSE)
```
data: {"chunk": "AI输出片段", "done": false}

data: {"chunk": "AI输出片段", "done": true, "sessionId": "<sessionId>"}
```

#### `GET /api/sessions`

查询当前可用会话列表。

### WebSocket

**客户端 → 服务器**
```json
{ "type": "tab_register", "tabId": 123 }
```

**服务器 → 客户端**
```json
{ "type": "send_message", "requestId": "xxx", "content": "用户消息", "tabId": 123 }
```

**客户端 → 服务器**
```json
{ "type": "stream_chunk", "chunk": "AI输出片段", "done": false }
{ "type": "stream_chunk", "chunk": "", "done": true }
{ "type": "error", "message": "错误描述" }
```
