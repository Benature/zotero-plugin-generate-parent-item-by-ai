# Parent Item Generator

> 一款 Zotero 9 插件，通过 AI 为独立 PDF 附件自动生成父条目。

[English](README.md)

## 功能特性

- 右键任意独立 PDF 附件 → **生成父条目**
- **两阶段提取**，节省 token：第一阶段仅发送文件名，仅在需要时才提取页面文字
- AI 自动选择最合适的 Zotero 条目类型（期刊文章、图书、报告、学位论文……），也可在设置中强制指定
- 交互式预览：接受、要求 AI 改进或取消，全程不影响现有数据
- 完全可配置：系统提示词和用户提示词模板均可在设置面板中修改

## 系统要求

- Zotero 9

## 工作流程

```
右键 PDF
      │
      ▼
第一阶段 ── 文件名 + 标题 ──► LLM
      │
      ├─ 元数据完整? ──► 预览对话框
      │                      │
      └─ 不完整 ─► 第二阶段   ├─ 接受 ──► 创建父条目
              │               ├─ 改进 ─► （按需提取页面文字）──► LLM ──► 预览
              │ 首页+末页文字  └─ 取消
              ▼
            LLM ──► 预览对话框
```

**第一阶段**：仅将文件名（及 Zotero 附件标题）发送给 LLM。
满足以下全部条件时视为元数据完整：条目类型、标题、日期、至少一位作者、至少一个机构类字段（期刊名、出版商、大学、机构等）。

**第二阶段**：当第一阶段元数据不完整时自动触发。使用 Zotero 内置 PDF Worker 提取首页与末页文字，连同文件名信息一起送给 LLM。

**改进**：支持多轮迭代。若上一轮未提取页面文字（第一阶段已足够），改进时会按需提取后再发起请求。

## 配置

打开 **Zotero → 偏好设置 → Parent Item Generator**。

| 字段 | 说明 |
|---|---|
| API 格式 | 协议格式：`OpenAI (/chat/completions)`、`Google Gemini (/models/{model}:generateContent)`、`Anthropic Claude (/messages)` 或 `Antigravity 原生 (/v1internal:generateContent)` |
| Base URL | API 根地址（如 `https://api.openai.com/v1`、`https://generativelanguage.googleapis.com/v1beta`、`https://api.anthropic.com/v1` 或本地/远端 Antigravity 代理） |
| API Key | 你的 API 密钥或 Bearer 令牌 |
| Model | 模型下拉选择框（自动从远端服务拉取模型列表，附带 ↻ 刷新按钮与自定义模型支持） |
| Forced Item Type | 强制指定条目类型，留空则由 AI 决定 |
| System Prompt | 自定义系统提示词，留空则使用内置默认值 |
| User Prompt Template | 自定义用户提示词模板，留空则使用内置默认值 |

点击 **测试连接** 可验证 Base URL、API Key 与模型是否有效。

### 支持的 API 格式与 Antigravity 配置

- **OpenAI 兼容** (`openai`)：默认格式，向 `${baseURL}/chat/completions` 发起请求。
- **Google Gemini** (`gemini`)：适用于 Google AI Studio 或 Antigravity Gemini v1beta 代理端点，向 `${baseURL}/models/${model}:generateContent` 发起请求。自动过滤 Gemini 2.5/3.x 推理思考内容（`thought: true`）。
- **Anthropic Claude** (`claude`)：适用于 Anthropic 或 Antigravity Claude v1 代理端点，向 `${baseURL}/messages` 发起请求，携带 `anthropic-version: 2023-06-01`。
- **Antigravity 原生** (`antigravity`)：适用于 Google Cloud Code / Antigravity 原生内部端点（`/v1internal:generateContent`）。自动注入客户端元数据并提取候选文本。

### 用户提示词模板占位符

| 占位符 | 替换为 |
|---|---|
| `{filename}` | PDF 文件名 |
| `{firstPage}` | 首页提取文字（第一阶段为空字符串） |
| `{lastPage}` | 末页提取文字（第一阶段为空字符串） |
| `{itemTypes}` | 所有 Zotero 条目类型及其有效字段列表 |
| `{forcedItemType}` | 使用强制条目类型的指令（未设置时为空） |

### AI 返回格式

AI 必须返回如下结构的 JSON 对象。自定义提示词必须保留此 schema：

```json
{
  "itemType": "report",
  "fields": {
    "title": "……",
    "date": "2024-03",
    "institution": "……"
  },
  "creators": [
    { "creatorType": "author", "firstName": "", "lastName": "张伟" }
  ],
  "tags": [],
  "reason": ""
}
```

`reason` 会显示在预览对话框中，并追加到创建条目的 `extra` 字段。


## 从 AI PDF Metadata Extractor 迁移

本插件原名 **AI PDF Metadata Extractor**（偏好键前缀 `extensions.aiPdfMetadataExtractor.*`）。新版前缀已改为 `extensions.parentItemGenerator.*`，旧配置**不会**自动迁移，请在偏好设置面板中重新填写 Base URL、API Key 和 Model。

## 开发

```bash
npm install
npm run build        # 类型检查 + 构建 XPI
npm run typecheck    # 仅类型检查
```

项目遵循 [`windingwind/zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template) 结构：
静态 addon 文件在 `addon/`，TypeScript 源码在 `src/`。

### 热重载（开发服务器）

```bash
npm run dev

# macOS — 若无法自动找到 Zotero 可执行文件：
npm run dev:mac
# 或手动指定路径
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero npm run dev
```

### 发布

```bash
npm run release
```

## 许可证

AGPL-3.0-or-later
