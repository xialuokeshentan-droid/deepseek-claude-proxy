const http = require('http');

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

if (!API_KEY) {
  console.error('ERROR: DEEPSEEK_API_KEY required');
  process.exit(1);
}

function convertMessages(body) {
  const msgs = [];
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system :
      (Array.isArray(body.system) ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
    if (text) msgs.push({ role: 'system', content: text });
  }
  if (body.messages) {
    for (const m of body.messages) {
      let content = m.content;
      if (Array.isArray(content)) {
        const parts = [];
        for (const b of content) {
          if (b.type === 'text') parts.push(b.text);
          else if (b.type === 'tool_result') {
            const t = typeof b.content === 'string' ? b.content :
              (Array.isArray(b.content) ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
            parts.push(`[Tool Result ${b.tool_use_id}]: ${t}`);
          }
        }
        content = parts.join('\n');
      }
      msgs.push({ role: m.role, content });
    }
  }
  return msgs;
}

function convertResponse(data) {
  const c = data.choices?.[0];
  if (!c) return { type: 'error', error: { type: 'api_error', message: 'No response' } };
  const content = [];
  if (c.message?.content) content.push({ type: 'text', text: c.message.content });
  if (c.message?.tool_calls) {
    for (const tc of c.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch(e) { input = { raw: tc.function.arguments }; }
      content.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2)}`, name: tc.function.name, input });
    }
  }
  let stop = 'end_turn';
  if (c.finish_reason === 'tool_calls') stop = 'tool_use';
  else if (c.finish_reason === 'length') stop = 'max_tokens';
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message', role: 'assistant', content,
    model: data.model || MODEL,
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 }
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', model: MODEL }));
  }
  
  if (req.method === 'POST' && req.url === '/v1/messages') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const reqData = JSON.parse(body);
        // ALWAYS override model to the configured DeepSeek model
        reqData.model = MODEL;
        
        const isStream = reqData.stream || false;
        const openaiReq = {
          model: MODEL,
          messages: convertMessages(reqData),
          max_tokens: reqData.max_tokens || 4096,
          temperature: reqData.temperature || 0.7,
          stream: isStream
        };
        
        if (reqData.tools) {
          openaiReq.tools = reqData.tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
          }));
        }
        
        console.log(`[${new Date().toISOString()}] Forwarding to ${BASE_URL}, model=${MODEL}`);
        const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
          body: JSON.stringify(openaiReq)
        });
        
        if (!resp.ok) {
          const err = await resp.text();
          console.error(`[${new Date().toISOString()}] Error: ${err}`);
          res.writeHead(resp.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err } }));
        }
        
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '', first = true;
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const d = line.slice(6).trim();
              if (d === '[DONE]') { res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); continue; }
              try {
                const chunk = JSON.parse(d);
                const delta = chunk.choices?.[0]?.delta;
                if (first) {
                  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_'+Math.random().toString(36).slice(2), type: 'message', role: 'assistant', content: [], model: MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
                  first = false;
                }
                if (delta?.content) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })}\n\n`);
                }
              } catch(e) {}
            }
          }
          res.end();
        } else {
          const data = await resp.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(convertResponse(data)));
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
      }
    });
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}, model=${MODEL}`));
