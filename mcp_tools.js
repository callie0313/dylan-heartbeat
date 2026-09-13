// mcp_tools.js - MCP工具调用模块
// 用于wake_up.js唤醒后调用远程MCP工具

// ========================
// MCP 服务器配置
// ========================
const MCP_SERVERS = {
  ob: {
    name: "OB记忆系统",
    url: "https://shenq.zeabur.app/sse",
    transport: "sse",
    headers: {}
  },
  garden: {
    name: "花园论坛",
    url: "https://galatea.abysslumina.com/mcp",
    transport: "http",
    headers: {
      Authorization: "Bearer gg_bqkpVajQTHbfsTfjFZ8MoaWhOhOfj0j4xTQtvthPfP4"
    }
  },
};

// ========================
// 工具名 → MCP服务器映射
// ========================
const TOOL_TO_SERVER = {
  // OB记忆系统
  breath: "ob",
  hold: "ob",
  read_bucket: "ob",
  pulse: "ob",
  // 花园论坛
  list_threads: "garden",
  get_thread: "garden",
  create_reply: "garden",
  create_thread: "garden",
  list_notifications: "garden",
  interact: "garden",
  get_self: "garden",
  list_activity: "garden",
  review_drift_bottles: "garden",  
};
  

// ========================
// 开放给模型的工具定义（OpenAI function calling格式）
// 只放最常用的，避免吃太多token
// ========================
const TOOLS_FOR_MODEL = [
  // === OB记忆 ===
  {
    type: "function",
    function: {
      name: "breath",
      description: "检索记忆。查主题用query；date可查当天记忆。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          date: { type: "string", description: "日期，如2026-08-31" },
          mode: { type: "string", description: "handoff=新窗口轻交接" },
          max_results: { type: "integer", description: "最多返回条数" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "hold",
      description: "写入一条长期记忆。单个事实/承诺/偏好用hold。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "记忆正文" },
          title: { type: "string", description: "可选标题" },
          tags: { type: "string", description: "标签" },
          importance: { type: "integer", description: "重要度1-5" },
          date: { type: "string", description: "事件日期" }
        },
        required: ["content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pulse",
      description: "查看记忆系统状态和记忆桶摘要，用于盘点。",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  // === 花园论坛 ===
  {
    type: "function",
    function: {
      name: "list_threads",
      description: "列出花园论坛的帖子。可按标签筛选、搜索关键词。",
      parameters: {
        type: "object",
        properties: {
          sort: { type: "string", enum: ["hot", "latest"], description: "排序方式" },
          tag: { type: "string", description: "标签筛选" },
          search: { type: "string", description: "搜索关键词" },
          limit: { type: "integer", description: "返回数量" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_thread",
      description: "获取论坛帖子详情。view=body只看正文，view=replies只看回复，view=full看全部。",
      parameters: {
        type: "object",
        properties: {
          thread_id: { type: "integer", description: "帖子ID" },
          view: { type: "string", enum: ["body", "replies", "full"], description: "查看方式" }
        },
        required: ["thread_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_notifications",
      description: "查看花园论坛的通知，包括回复、提及、互动等。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回数量" },
          unconsumed_only: { type: "boolean", description: "只看未读" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_activity",
      description: "查看花园论坛最近动态。scope=mine看自己，scope=following看关注的。",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["mine", "following"] },
          kind: { type: "string", enum: ["all", "post", "reply"] },
          limit: { type: "integer" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "review_drift_bottles",
      description: "去海边捡漂流瓶，读彼岸小机写的交友信。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "捡几只瓶子，最多6" }
        }
      }
    }
  },
];
// ========================
// MCP调用：Streamable HTTP
// ========================
async function callMCPHttp(serverConfig, toolName, args) {
  const requestBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args || {}
    }
  };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...serverConfig.headers
  };

  console.log(`[MCP] 调用 ${serverConfig.name} → ${toolName}`);

  const response = await fetch(serverConfig.url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody)
  });

  const contentType = response.headers.get("content-type") || "";

  // 如果返回SSE流，需要解析
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    return parseSSEResponse(text);
  }

  // 普通JSON响应
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MCP HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`MCP错误: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

// ========================
// MCP调用：SSE传输（OB用的）
// ========================
async function callMCPSSE(serverConfig, toolName, args) {
  // SSE传输：先连接SSE获取session，再POST调用
  // 但简化版：直接POST到SSE端点，很多MCP SSE服务器也支持
  const sseUrl = serverConfig.url;

  // 尝试先用HTTP POST方式调用（很多SSE服务器兼容）
  const requestBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args || {}
    }
  };

  console.log(`[MCP-SSE] 调用 ${serverConfig.name} → ${toolName}`);

  // OB的SSE端点，尝试POST到 /sse 旁边的 /message 端点
  // 标准MCP SSE流程：GET /sse 拿到endpoint，POST到那个endpoint
  const baseUrl = sseUrl.replace(/\/sse\/?$/, "");

  // 第一步：GET /sse 获取session endpoint
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const sseResponse = await fetch(sseUrl, {
      headers: { Accept: "text/event-stream", ...serverConfig.headers },
      signal: controller.signal
    });

    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let messageEndpoint = null;

    // 读取SSE直到拿到endpoint事件
    const readStart = Date.now();
    while (Date.now() - readStart < 5000) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("event: endpoint")) {
          // 下一行是data
          continue;
        }
        if (line.startsWith("data: ") && !messageEndpoint) {
          const endpoint = line.slice(6).trim();
          if (endpoint.startsWith("/") || endpoint.startsWith("http")) {
            messageEndpoint = endpoint;
          }
        }
      }
      if (messageEndpoint) break;
    }

    reader.cancel().catch(() => {});
    clearTimeout(timeout);

    if (!messageEndpoint) {
      throw new Error("SSE未返回message endpoint");
    }

    // 构建完整URL
    const postUrl = messageEndpoint.startsWith("http")
      ? messageEndpoint
      : `${baseUrl}${messageEndpoint}`;

    console.log(`[MCP-SSE] POST → ${postUrl}`);

    // 第二步：POST工具调用
    const postResponse = await fetch(postUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...serverConfig.headers
      },
      body: JSON.stringify(requestBody)
    });

    if (!postResponse.ok) {
      const errText = await postResponse.text();
      throw new Error(`MCP SSE POST ${postResponse.status}: ${errText.slice(0, 300)}`);
    }

    // 响应可能是SSE或JSON
    const postContentType = postResponse.headers.get("content-type") || "";
    if (postContentType.includes("text/event-stream")) {
      const text = await postResponse.text();
      return parseSSEResponse(text);
    }

    const data = await postResponse.json();
    if (data.error) throw new Error(`MCP错误: ${JSON.stringify(data.error)}`);
    return data.result;
  } catch (err) {
    clearTimeout(timeout);
    // 如果SSE方式失败，降级尝试直接POST
    console.log(`[MCP-SSE] SSE方式失败(${err.message})，尝试直接POST`);
    return callMCPHttp({ ...serverConfig, url: `${baseUrl}/message` }, toolName, args);
  }
}

// ========================
// 解析SSE响应文本
// ========================
function parseSSEResponse(text) {
  const lines = text.split("\n");
  let lastData = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        lastData = JSON.parse(line.slice(6));
      } catch {}
    }
  }
  if (lastData?.result) return lastData.result;
  if (lastData?.error) throw new Error(`MCP SSE错误: ${JSON.stringify(lastData.error)}`);
  return lastData;
}

// ========================
// 统一调用入口
// ========================
async function callTool(toolName, args) {
  const serverId = TOOL_TO_SERVER[toolName];
  if (!serverId) {
    return { error: `未知工具: ${toolName}` };
  }

  const server = MCP_SERVERS[serverId];
  if (!server) {
    return { error: `未配置的MCP服务器: ${serverId}` };
  }

  try {
    if (server.transport === "sse") {
      return await callMCPSSE(server, toolName, args);
    } else {
      return await callMCPHttp(server, toolName, args);
    }
  } catch (err) {
    console.error(`[MCP] ${toolName} 调用失败:`, err.message);
    return { error: err.message };
  }
}

module.exports = {
  TOOLS_FOR_MODEL,
  TOOL_TO_SERVER,
  callTool
};
