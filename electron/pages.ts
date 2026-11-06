/** Tiny inline pages shown before the Next server answers (or when it fails). */

const shell = (body: string) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Magpipe</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html,body{margin:0;height:100%;background:#101010;color:#f2f2f2;
    font:14px/20px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-app-region:drag}
  main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:0 24px}
  .orb{width:56px;height:56px;border-radius:9999px;background:#fff;box-shadow:0 0 40px rgba(34,193,220,.35);
    animation:p 1.6s ease-in-out infinite alternate}
  @keyframes p{to{box-shadow:0 0 12px rgba(34,193,220,.15);opacity:.7}}
  .eyebrow{font-weight:600;letter-spacing:2.52px;text-transform:uppercase;color:#66d9e8}
  p{margin:0;color:#bdbdbd;max-width:520px}
  code{font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;color:#f5f6f7}
  @media (prefers-reduced-motion:reduce){.orb{animation:none}}
</style></head><body><main>${body}</main></body></html>`);

export const loadingPage = () =>
  shell(
    `<div class="orb" aria-hidden="true"></div><span class="eyebrow">Magpipe</span><p>Waking the flock…</p>`,
  );

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const errorPage = (message: string, logDir?: string) =>
  shell(
    `<span class="eyebrow" style="color:#f87171">Magpipe could not start</span><p>${escape(message)}</p>` +
      (logDir ? `<p>Logs: <code>${escape(logDir)}</code></p>` : ''),
  );
