/* CPI Helper Lite content script */
(function(){
  const state = {
    urlExtension: "",
    tenant: location.host,
    runtimeLocations: [],
    currentPlatform: /cfapps/.test(location.host) ? "cf" : "neo",
  };

  function absolutePath(href){
    const a = document.createElement('a');
    a.href = href;
    return a.protocol + '//' + a.host + a.pathname + a.search + a.hash;
  }

  // detect classic itspaces prefix for NEO
  function computeUrlExtension(){
    const isCF = /integrationsuite(-trial)?/.test(location.host);
    return isCF ? "" : "itspaces/";
  }

  async function http(method, url, accept){
    return new Promise((resolve, reject)=>{
      const xhr = new XMLHttpRequest();
      xhr.withCredentials = true;
      xhr.open(method, absolutePath(url));
      if (accept) xhr.setRequestHeader('Accept', accept);
      xhr.onload = ()=>{
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
        reject(new Error(method+" "+url+" status "+xhr.status));
      };
      xhr.onerror = ()=>reject(new Error("network error"));
      xhr.send();
    });
  }

  async function listAllIflowsCF(){
    // 1) Runtime locations
    const runtimeXml = await http('GET', '/'+state.urlExtension+'Operations/com.sap.it.op.srv.web.cf.RuntimeLocationListCommand');
    const runtimeJson = new XmlToJson().parse(runtimeXml)['com.sap.it.op.srv.web.cf.RuntimeLocationListResponse'];
    const locations = Array.isArray(runtimeJson.runtimeLocations) ? runtimeJson.runtimeLocations : [runtimeJson.runtimeLocations];
    state.runtimeLocations = locations.filter(l=>String(l.state).toUpperCase()==='ACTIVE');

    // 2) For each location, list Integration Components and aggregate artifacts
    const seen = new Map();
    for (const loc of state.runtimeLocations){
      const respXml = await http('GET', '/'+state.urlExtension+'Operations/com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListCommand?runtimeLocationId='+encodeURIComponent(loc.id));
      const parsed = new XmlToJson().parse(respXml)['com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListResponse'];
      const list = Array.isArray(parsed.artifactInformations) ? parsed.artifactInformations : (parsed.artifactInformations ? [parsed.artifactInformations] : []);
      for (const a of list){
        if (!a || !a.symbolicName) continue;
        if (!seen.has(a.symbolicName)){
          seen.set(a.symbolicName, { id: a.id, name: a.name, symbolicName: a.symbolicName });
        }
      }
    }
    return Array.from(seen.values());
  }

  async function listAllIflowsNEO(){
    const respXml = await http('GET', '/'+state.urlExtension+'Operations/com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListCommand');
    const parsed = new XmlToJson().parse(respXml)['com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListResponse'];
    const list = Array.isArray(parsed.artifactInformations) ? parsed.artifactInformations : (parsed.artifactInformations ? [parsed.artifactInformations] : []);
    return list.map(a=>({ id: a.id, name: a.name, symbolicName: a.symbolicName }));
  }

  async function getCountsForIflow(symbolicName){
    // Count across all available logs
    const to = new Date();
    const from = new Date(to.getTime() - 24*60*60*1000); // kept for potential future narrowing
    const iso = d=>new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().replace('Z','');
    const baseCount = '/'+state.urlExtension+"odata/api/v1/MessageProcessingLogs/$count";
    const common = ` and Status ne 'DISCARDED'`;

    // Escape single quotes for OData literal and URL-encode the entire $filter expression
    const esc = (s)=>String(s).replace(/'/g, "''");
    const filterCompleted = `IntegrationFlowName eq '${esc(symbolicName)}' and Status eq 'COMPLETED'${common}`;
    const filterFailed    = `IntegrationFlowName eq '${esc(symbolicName)}' and Status eq 'FAILED'${common}`;

    const qCompleted = `${baseCount}?$filter=${encodeURIComponent(filterCompleted)}`;
    const qFailed    = `${baseCount}?$filter=${encodeURIComponent(filterFailed)}`;

    const completed = parseInt(await http('GET', qCompleted, 'text/plain'), 10) || 0;
    const failed    = parseInt(await http('GET', qFailed, 'text/plain'), 10) || 0;
    return { completed, failed };
  }

  async function collect(){
    state.urlExtension = computeUrlExtension();
    const iflows = state.currentPlatform === 'cf' ? await listAllIflowsCF() : await listAllIflowsNEO();
    // Parallel counts with small concurrency to avoid hammering
    const results = [];
    const batchSize = 6;
    for (let i=0;i<iflows.length;i+=batchSize){
      const slice = iflows.slice(i,i+batchSize);
      const part = await Promise.all(slice.map(async f=>({
        name: f.name || f.symbolicName,
        symbolicName: f.symbolicName,
        ...(await getCountsForIflow(f.symbolicName))
      })));
      results.push(...part);
    }
    return results;
  }

  // Handle requests from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    if (msg && msg.type === 'CPI_LITE_LOAD'){
      (async ()=>{
        try{
          const data = await collect();
          sendResponse({ ok:true, data });
        }catch(e){
          sendResponse({ ok:false, error: String(e && e.message || e) });
        }
      })();
      return true; // async response
    }
  });

  // ============ In-page embedding (left navigation entry + panel) ============
  // This code injects a left navigation item named "CPI Helper Lite" into the
  // SAP Integration Suite side navigation. Clicking the item opens an in-page
  // panel that renders the same iFlows table as the popup.

  function ensureStyles(){
    if (document.getElementById('cpi-lite-embed-style')) return;
    const style = document.createElement('style');
    style.id = 'cpi-lite-embed-style';
    style.textContent = `
      .cpi-lite-panel{position:fixed; inset:auto 0 0 auto; top:64px; right:16px; width:min(860px, 92vw); height:calc(100vh - 80px); background:#fff; color:#1b1b1b; box-shadow:0 6px 24px rgba(0,0,0,.2); border-radius:8px; display:flex; flex-direction:column; z-index:2147483000;}
      .cpi-lite-dark .cpi-lite-panel{background:#1c2834; color:#eaecef;}
      .cpi-lite-header{display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid rgba(0,0,0,.08)}
      .cpi-lite-dark .cpi-lite-header{border-bottom-color:rgba(255,255,255,.12)}
      .cpi-lite-title{font-size:14px; font-weight:600}
      .cpi-lite-close{border:none; background:transparent; cursor:pointer; font-size:16px}
      .cpi-lite-body{padding:12px; overflow:auto}
      .cpi-lite-table{border-collapse:collapse; width:100%}
      .cpi-lite-table th,.cpi-lite-table td{border-bottom:1px solid rgba(0,0,0,.06); padding:8px; text-align:left}
      .cpi-lite-table th{background:rgba(0,0,0,.03); position:sticky; top:0; z-index:1}
      .cpi-lite-count{ text-align:right }
      .cpi-lite-ok{ color:#2c7a2c }
      .cpi-lite-fail{ color:#c53030 }
      .cpi-lite-nav-btn{ display:flex; align-items:center; gap:8px; padding:8px 10px; margin:6px 8px; border-radius:6px; cursor:pointer; user-select:none;}
      .cpi-lite-nav-btn:hover{ background:rgba(0,0,0,.06) }
    `;
    document.head.appendChild(style);
  }

  function isDark(){
    // UI5 Horizon dark theme class
    return document.documentElement.classList.contains('sapUiTheme-sap_horizon_dark');
  }

  function renderInPage(rows){
    ensureStyles();
    const rootId = 'cpi-lite-panel-root';
    let root = document.getElementById(rootId);
    const wrapperClass = isDark() ? 'cpi-lite-dark' : '';
    if (!root){
      root = document.createElement('div');
      root.id = rootId;
      root.className = wrapperClass;
      document.body.appendChild(root);
    } else {
      root.className = wrapperClass;
      root.innerHTML = '';
    }

    const panel = document.createElement('div');
    panel.className = 'cpi-lite-panel';
    const header = document.createElement('div');
    header.className = 'cpi-lite-header';
    const title = document.createElement('div');
    title.className = 'cpi-lite-title';
    title.textContent = 'iFlows and Message Counts';
    const close = document.createElement('button');
    close.className = 'cpi-lite-close';
    close.setAttribute('aria-label','Close');
    close.textContent = '✕';
    close.onclick = ()=> root.remove();
    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'cpi-lite-body';
    const table = document.createElement('table');
    table.className = 'cpi-lite-table';
    table.innerHTML = '<thead><tr><th style="width:55%">iFlow</th><th style="width:22%" class="cpi-lite-count">Completed</th><th style="width:23%" class="cpi-lite-count">Failed</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    const fmt = n=> new Intl.NumberFormat().format(n);
    rows.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    for (const r of rows){
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const tdOk = document.createElement('td');
      const tdFail = document.createElement('td');
      tdName.textContent = r.name || r.symbolicName;
      tdOk.textContent = fmt(r.completed||0);
      tdFail.textContent = fmt(r.failed||0);
      tdOk.className = 'cpi-lite-count cpi-lite-ok';
      tdFail.className = 'cpi-lite-count cpi-lite-fail';
      tr.appendChild(tdName);
      tr.appendChild(tdOk);
      tr.appendChild(tdFail);
      tbody.appendChild(tr);
    }
    body.appendChild(table);

    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(panel);
  }

  function findMainContentContainer(){
    const candidates = [
      document.querySelector('[id$="--toolPage-contentWrapper"] .sapTntToolPageContent'),
      document.querySelector('.sapTntToolPageContent'),
      document.querySelector('#shell--content'),
      document.querySelector('[id$="--pageContent"]'),
      document.querySelector('main'),
    ];
    return candidates.find(Boolean) || null;
  }

  function renderFullPage(rows){
    ensureStyles();
    const container = findMainContentContainer();
    if (!container){
      // fallback to floating panel if tool page not found yet
      renderInPage(rows);
      return;
    }
    let root = container.querySelector('#cpi-lite-page-root');
    const wrapperClass = isDark() ? 'cpi-lite-dark' : '';
    if (!root){
      root = document.createElement('div');
      root.id = 'cpi-lite-page-root';
      container.appendChild(root);
    }
    root.className = wrapperClass;
    root.innerHTML = '';

    const page = document.createElement('section');
    page.className = 'cpi-lite-body';
    const header = document.createElement('div');
    header.className = 'cpi-lite-header';
    const title = document.createElement('div');
    title.className = 'cpi-lite-title';
    title.textContent = 'CPI Helper Lite';
    header.appendChild(title);
    const table = document.createElement('table');
    table.className = 'cpi-lite-table';
    table.innerHTML = '<thead><tr><th style="width:55%">iFlow</th><th style="width:22%" class="cpi-lite-count">Completed</th><th style="width:23%" class="cpi-lite-count">Failed</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    const fmt = n=> new Intl.NumberFormat().format(n);
    rows.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    for (const r of rows){
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const tdOk = document.createElement('td');
      const tdFail = document.createElement('td');
      tdName.textContent = r.name || r.symbolicName;
      tdOk.textContent = fmt(r.completed||0);
      tdFail.textContent = fmt(r.failed||0);
      tdOk.className = 'cpi-lite-count cpi-lite-ok';
      tdFail.className = 'cpi-lite-count cpi-lite-fail';
      tr.appendChild(tdName);
      tr.appendChild(tdOk);
      tr.appendChild(tdFail);
      tbody.appendChild(tr);
    }
    page.appendChild(header);
    page.appendChild(table);
    root.appendChild(page);
  }

  async function openInPage(){
    try{
      // Prefer full-page render if we find the main content area
      const main = findMainContentContainer();
      if (main){
        renderFullPage([]);
      } else {
        renderInPage([]);
      }
      const data = await collect();
      if (main){
        renderFullPage(data||[]);
      } else {
        renderInPage(data||[]);
      }
    }catch(e){
      // In case of error, still show panel with message
      ensureStyles();
      const rootId = 'cpi-lite-panel-root';
      let root = document.getElementById(rootId);
      if (!root){ root = document.createElement('div'); root.id=rootId; document.body.appendChild(root); }
      root.innerHTML = `<div class="cpi-lite-panel"><div class="cpi-lite-header"><div class="cpi-lite-title">CPI Helper Lite</div><button class="cpi-lite-close" aria-label="Close">✕</button></div><div class="cpi-lite-body"><div style="color:#c53030">${String(e && e.message || e)}</div></div></div>`;
      root.querySelector('.cpi-lite-close')?.addEventListener('click', ()=>root.remove());
    }
  }

  function findSideNavContainer(){
    const candidates = [
      document.querySelector('#shell--sideNavigation nav ul'),
      document.querySelector('#shell--sideNavigation [role="menu"]'),
      document.querySelector('#shell--sideNavigation'),
      document.querySelector('[id$="--sideNavigation"] [role="menu"]'),
      document.querySelector('[id$="--sideNavigation"]'),
      document.querySelector('.sapTntSideNavigation [role="menu"]'),
      document.querySelector('.sapTntSideNavigation')
    ];
    return candidates.find(Boolean) || null;
  }

  function injectLeftNavButton(){
    const parent = findSideNavContainer();
    if (!parent) return false;
    if (document.getElementById('cpi-lite-nav-item')) return true;

    const item = document.createElement('div');
    item.id = 'cpi-lite-nav-item';
    item.className = 'cpi-lite-nav-btn';
    const icon = document.createElement('img');
    icon.alt = '';
    icon.width = 16; icon.height = 16;
    icon.src = chrome.runtime.getURL('images/v4/16.png');
    const text = document.createElement('span');
    text.textContent = 'CPI Helper Lite';
    item.appendChild(icon);
    item.appendChild(text);
    item.addEventListener('click', openInPage);

    // Try to append in a reasonable place: after first group of items
    try{ parent.appendChild(item); }
    catch(_e){ document.body.appendChild(item); }
    return true;
  }

  // attempt injection repeatedly until it succeeds
  function boot(){
    ensureStyles();
    let attempts = 0;
    const timer = setInterval(()=>{
      attempts++;
      if (injectLeftNavButton()){ clearInterval(timer); }
      if (attempts>180){ clearInterval(timer); } // stop after ~3 minutes
    }, 1000);

    // Also observe for theme changes to update dark mode styling
    const obs = new MutationObserver(()=>{
      const root = document.getElementById('cpi-lite-panel-root');
      if (root){ root.className = isDark() ? 'cpi-lite-dark' : ''; }
    });
    obs.observe(document.documentElement, { attributes:true, attributeFilter:['class'] });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
