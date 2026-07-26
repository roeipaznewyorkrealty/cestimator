// Netlify serverless function — server-side proxy to the Anthropic API.
// The API key lives in the ANTHROPIC_API_KEY environment variable (set in the
// Netlify dashboard), never in the browser. The frontend posts one plan file
// at a time plus the extraction prompt; this returns the model's text reply.
//
// Endpoint (after deploy):  /.netlify/functions/analyze
const FN_VERSION = '2026-07-17b';
exports.handler = async (event) => {
  // Health check: GET returns the deployed function version (proves what's live).
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, version: FN_VERSION, keySet: !!process.env.ANTHROPIC_API_KEY }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed', version: FN_VERSION }) };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in Netlify environment variables.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { file, parts, prompt } = body;
  if (!prompt || (!Array.isArray(parts) && !(file && file.data))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Expected { parts:[{media_type,data}], prompt } or { file:{kind,media_type,data}, prompt }' }) };
  }

  let content;
  if (Array.isArray(parts) && parts.length) {
    content = parts.map(p => ({ type: 'image', source: { type: 'base64', media_type: (p && p.media_type) || 'image/jpeg', data: p && p.data } }));
  } else if (file && file.data) {
    content = [ (file.kind === 'pdf')
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
      : { type: 'image', source: { type: 'base64', media_type: file.media_type || 'image/png', data: file.data } } ];
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'No image parts or file provided.' }) };
  }

  // Guard the upstream call with our own timeout so we return a clean JSON error
  // instead of letting the platform kill us with a bare 502.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 22000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }],
      }),
    });
    clearTimeout(timer);

    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('Anthropic API error ' + resp.status);
      return { statusCode: resp.status, body: JSON.stringify({ error: msg }) };
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError');
    return { statusCode: aborted ? 504 : 500,
      body: JSON.stringify({ error: aborted
        ? 'the model call took too long — upload fewer pages, or the key sheets only (cover, floor plan, schedules).'
        : String((e && e.message) || e) }) };
  }
};
