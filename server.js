const http = require('http');

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

if (!API_KEY) {
  console.error('ERROR: DEEPSEEK_API_KEY required');
  process.exit(1);
}

console.log('Starting proxy: model=' + MODEL + ', base_url=' + BASE_URL);

function convertMessages(body) {
  const msgs = [];
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system :
      (Array.isArray(body.system) ? body.system.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n') : '');
    if (text) msgs.push({ role: 'system', content: text });
  }
  if (body.messages) {
    for (var i = 0; i < body.messages.length; i++) {
      var m = body.messages[i];
      var content = m.content;
      if (Array.isArray(content)) {
        var parts = [];
        for (var j = 0; j < content.length; j++) {
          var b = content[j];
          if (b.type === 'text') parts.push(b.text);
          else if (b.type === 'tool_result') {
            var t = typeof b.content === 'string' ? b.content :
              (Array.isArray(b.content) ? b.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('\n') : '');
            parts.push('[Tool Result ' + b.tool_use_id + ']: ' + t);
          }
        }
        content = parts.join('\n');
      }
      msgs.push({ role: m.role, content: content });
    }
  }
  return msgs;
}

function convertResponse(data) {
  var c = data.choices && data.choices[0];
  if (!c) return { type: 'error', error: { type: 'api_error', message: 'No response' } };
  var content = [];
  if (c.message && c.message.content) content.push({ type: 'text', text: c.message.content });
  if (c.message && c.message.tool_calls) {
    for (var i = 0; i < c.message.tool_calls.length; i++) {
      var tc = c.message.tool_calls[i];
      var input = {};
      try { input = JSON.parse(tc.function.arguments); } catch(e) { input = { raw: tc.function.arguments }; }
      content.push({ type: 'tool_use', id: tc.id || 'toolu_' + Math.random().toString(36).slice(2), name: tc.function.name, input: input });
    }
  }
  var stop = 'end_turn';
  if (c.finish_reason === 'tool_calls') stop = 'tool_use';
  else if (c.finish_reason === 'length') stop = 'max_tokens';
  return {
    id: 'msg_' + Math.random().toString(36).slice(2),
    type: 'message', role: 'assistant', content: content,
    model: MODEL,
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: (data.usage && data.usage.prompt_tokens) || 0, output_tokens: (data.usage && data.usage.completion_tokens) || 0 }
  };
}

var server = http.createServer(async function(req, res) {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', model: MODEL }));
  }

  // Model validation endpoint
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4-pro', object: 'model', created: 1700000000, owned_by: 'deepseek' },
        { id: 'deepseek-v4-flash', object: 'model', created: 1700000000, owned_by: 'deepseek' },
        { id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model', created: 1700000000, owned_by: 'deepseek' }
      ]
    }));
  }

  // Anthropic Messages API endpoint
  if (req.method === 'POST' && (req.url === '/v1/messages' || req.url === '/messages')) {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      try {
        var reqData = JSON.parse(body);
        console.log('[' + new Date().toISOString() + '] Request: model=' + reqData.model + ' -> ' + MODEL);

        var isStream = reqData.stream || false;
        var openaiReq = {
          model: MODEL,
          messages: convertMessages(reqData),
          max_tokens: reqData.max_tokens || 4096,
          temperature: reqData.temperature || 0.7,
          stream: isStream
        };

        if (reqData.tools) {
          openaiReq.tools = reqData.tools.map(function(t) {
            return {
              type: 'function',
              function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
            };
          });
        }

        var resp = await fetch(BASE_URL + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
          body: JSON.stringify(openaiReq)
        });

        if (!resp.ok) {
          var err = await resp.text();
          console.error('[' + new Date().toISOString() + '] DeepSeek error: ' + resp.status + ' ' + err);
          res.writeHead(resp.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err } }));
        }

        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          var reader = resp.body.getReader();
          var decoder = new TextDecoder();
          var buf = '';
          var first = true;

          while (true) {
            var result = await reader.read();
            if (result.done) break;
            buf += decoder.decode(result.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop() || '';

            for (var li = 0; li < lines.length; li++) {
              var line = lines[li];
              if (line.indexOf('data: ') !== 0) continue;
              var d = line.slice(6).trim();
              if (d === '[DONE]') {
                res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                continue;
              }
              try {
                var chunk = JSON.parse(d);
                var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
                if (first) {
                  res.write('event: message_start\ndata: ' + JSON.stringify({
                    type: 'message_start',
                    message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', content: [], model: MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
                  }) + '\n\n');
                  res.write('event: content_block_start\ndata: ' + JSON.stringify({
                    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
                  }) + '\n\n');
                  first = false;
                }
                if (delta && delta.content) {
                  res.write('event: content_block_delta\ndata: ' + JSON.stringify({
                    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content }
                  }) + '\n\n');
                }
              } catch(e) {}
            }
          }
          res.end();
        } else {
          var data = await resp.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(convertResponse(data)));
        }
      } catch(e) {
        console.error('[' + new Date().toISOString() + '] Error: ' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', available_endpoints: ['GET /health', 'GET /v1/models', 'POST /v1/messages'] }));
});

server.listen(PORT, function() { console.log('Proxy running on port ' + PORT + ', model=' + MODEL); });
