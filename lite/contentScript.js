/* CPI Helper Lite content script */
(function(){
  const state = {
    urlExtension: "",
    tenant: location.host,
    runtimeLocations: [],
    currentPlatform: /cfapps/.test(location.host) ? "cf" : "neo",
    cachedRows: [],
    pageIndex: 0,
    batchSize: 25,
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

  async function listFailedMessagesForIflow(symbolicName, top=200){
    const esc = (s)=>String(s).replace(/'/g, "''");
    const filter = `IntegrationFlowName eq '${esc(symbolicName)}' and Status eq 'FAILED'`;
    const baseLogs = '/' + state.urlExtension + 'odata/api/v1/MessageProcessingLogs';
    const logsQs = `?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('LogStart desc')}&$top=${encodeURIComponent(String(top))}&$format=json`;

    function normalizeJsonList(txt){
      let json; try{ json = JSON.parse(txt); }catch(_e){ return []; }
      const arr = (json && (json.value || (json.d && json.d.results))) || [];
      const getAny = (obj, names)=>{
        for (const name of names){
          if (!obj) break;
          if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
          const lower = Object.keys(obj).find(k=>k.toLowerCase()===name.toLowerCase());
          if (lower) return obj[lower];
        }
        return undefined;
      };
      return arr.map(x=>({
        messageId: String(getAny(x, ['MessageGuid','MessageID','MessageId','Guid','GUID','MessageGUID']) || ''),
        status: String(getAny(x, ['Status']) || 'FAILED'),
        errorText: String(getAny(x, ['ErrorText','Error','ErrorMessage']) || ''),
        logStart: getAny(x, ['LogStart','TimeStamp']) || null,
        integrationFlowName: String(getAny(x, ['IntegrationFlowName']) || symbolicName)
      }));
    }

    function normalizeXmlList(txt){
      const parsed = new XmlToJson().parse(txt);
      const feed = parsed && parsed.feed;
      const entries = feed && feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];
      const list = [];
      for (const en of entries){
        const props = (en && en.content && (en.content["m:properties"] || en.content.properties)) || {};
        const get = (name)=> props[name] ?? props['d:'+name] ?? props['m:'+name];
        list.push({
          messageId: String(get('MessageGuid') || get('MessageID') || get('MessageId') || ''),
          status: String(get('Status') || 'FAILED'),
          errorText: String(get('ErrorText') || get('Error') || ''),
          logStart: get('LogStart') || null,
          integrationFlowName: String(get('IntegrationFlowName') || symbolicName)
        });
      }
      return list;
    }

    // 1) Get the list of failed logs (JSON first, then XML fallback)
    let logs = [];
    try{
      const txt = await http('GET', baseLogs + logsQs, 'application/json');
      logs = normalizeJsonList(txt);
    }catch(_e){ logs = []; }
    if (!Array.isArray(logs) || logs.length === 0){
      const xmlTxt = await http('GET', baseLogs + `?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('LogStart desc')}&$top=${encodeURIComponent(String(top))}`, 'application/xml');
      logs = normalizeXmlList(xmlTxt);
    }

    // 2) For each message, fetch detailed error info
    async function fetchErrorDetailsFor(messageId){
      if (!messageId) return '';
      const escId = String(messageId).replace(/'/g, "''");
      const base = '/' + state.urlExtension + 'odata/api/v1/MessageProcessingLogs';
      const candidatesJson = [
        `${base}('${encodeURIComponent(escId)}')/ErrorInformation?$format=json`,
        `${base}(MessageGuid='${encodeURIComponent(escId)}')/ErrorInformation?$format=json`
      ];
      for (const url of candidatesJson){
        try{
          const txt = await http('GET', url, 'application/json');
          let json; try{ json = JSON.parse(txt); }catch(_e){ json = {}; }
          const arr = (json && (json.value || (json.d && json.d.results))) || [];
          const details = arr.map(e=> e.ErrorText || e.LongText || e.Message || e.Text || e.LogMessage || '').filter(Boolean).join(' | ');
          if (details) return details;
        }catch(_e){/* try next */}
      }

      // XML fallbacks for both key syntaxes
      const candidatesXml = [
        `${base}('${encodeURIComponent(escId)}')/ErrorInformation`,
        `${base}(MessageGuid='${encodeURIComponent(escId)}')/ErrorInformation`
      ];
      for (const url of candidatesXml){
        try{
          const xmlTxt = await http('GET', url, 'application/xml');
          const parsed = new XmlToJson().parse(xmlTxt);
          const feed = parsed && (parsed.feed || parsed['m:feed']);
          const entries = feed && feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];
          const list = [];
          for (const en of entries){
            const props = (en && en.content && (en.content["m:properties"] || en.content.properties)) || {};
            const get = (name)=> props[name] ?? props['d:'+name] ?? props['m:'+name];
            list.push(get('ErrorText') || get('LongText') || get('Message') || get('Text') || get('LogMessage') || '');
          }
          const details = list.filter(Boolean).join(' | ');
          if (details) return details;
        }catch(_e){/* try next */}
      }
      return '';
    }

    const results = [];
    const concurrency = 6;
    for (let i=0;i<logs.length;i+=concurrency){
      const slice = logs.slice(i, i+concurrency);
      const part = await Promise.all(slice.map(async m=>({
        messageId: m.messageId,
        status: m.status,
        errorText: m.errorText,
        errorDetails: await fetchErrorDetailsFor(m.messageId),
        logStart: m.logStart,
        integrationFlowName: m.integrationFlowName
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
      #cpi-lite-page-root{ height:100%; display:flex; flex-direction:column; }
      .cpi-lite-header{display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid rgba(0,0,0,.08)}
      .cpi-lite-dark .cpi-lite-header{border-bottom-color:rgba(255,255,255,.12)}
      .cpi-lite-title{font-size:14px; font-weight:600}
      .cpi-lite-close{border:none; background:transparent; cursor:pointer; font-size:16px}
      .cpi-lite-body{padding:12px; overflow:auto; height:100%; flex:1;}
      .cpi-lite-table{border-collapse:collapse; width:100%}
      .cpi-lite-table th,.cpi-lite-table td{border-bottom:1px solid rgba(0,0,0,.06); padding:8px; text-align:left}
      .cpi-lite-table th{background:rgba(0,0,0,.03); position:sticky; top:0; z-index:1}
      .cpi-lite-count{ text-align:right }
      .cpi-lite-ok{ color:#2c7a2c }
      .cpi-lite-fail{ color:#c53030 }
      .cpi-lite-nav-btn{ display:flex; align-items:center; gap:8px; padding:8px 10px; margin:6px 8px; border-radius:6px; cursor:pointer; user-select:none;}
      .cpi-lite-nav-btn:hover{ background:rgba(0,0,0,.06) }
      .cpi-lite-hidden{ display:none !important }
      .cpi-lite-controls{ display:flex; gap:12px; align-items:center; margin:12px 0 }
      .cpi-lite-input{ padding:6px 8px; border:1px solid rgba(0,0,0,.2); border-radius:6px; width:110px }
      .cpi-lite-btn{ padding:6px 12px; border:1px solid rgba(0,0,0,.2); border-radius:6px; background:#1f2d40; color:#fff; cursor:pointer }
      .cpi-lite-btn:disabled{ opacity:.6; cursor:default }
      .cpi-lite-pager{ display:flex; gap:8px; align-items:center; margin:10px 0 }
      .cpi-lite-link{ color:#0a66c2; cursor:pointer; user-select:none }
      .cpi-lite-back{ padding:6px 10px; border:1px solid rgba(0,0,0,.2); border-radius:6px; background:#eef3f8; color:#1b1b1b; cursor:pointer; margin-right:8px }
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
    // Controls
    const controls = document.createElement('div');
    controls.className = 'cpi-lite-controls';
    controls.innerHTML = `
      <label>BatchSize: <input id="cpi-lite-batch" class="cpi-lite-input" type="number" min="1" step="1" value="${state.batchSize}"></label>
      <button id="cpi-lite-load" class="cpi-lite-btn">Get Message Overview</button>
      <span id="cpi-lite-status" style="margin-left:8px; color:#666;"></span>
    `;
    body.appendChild(controls);
    // Pagination section
    const pager = document.createElement('div');
    pager.className = 'cpi-lite-pager';
    pager.innerHTML = `
      <span id="cpi-lite-prev" class="cpi-lite-link">Prev</span>
      <span id="cpi-lite-page"></span>
      <span id="cpi-lite-next" class="cpi-lite-link">Next</span>
    `;
    const table = document.createElement('table');
    table.className = 'cpi-lite-table';
    table.innerHTML = '<thead><tr><th style="width:55%">iFlow</th><th style="width:22%" class="cpi-lite-count">Completed</th><th style="width:23%" class="cpi-lite-count">Failed</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    const fmt = n=> new Intl.NumberFormat().format(n);
    const rowsToRender = Array.isArray(rows) ? rows : [];
    rowsToRender.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    const start = state.pageIndex * state.batchSize;
    const pageRows = rowsToRender.slice(start, start + state.batchSize);
    for (const r of pageRows){
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const tdOk = document.createElement('td');
      const tdFail = document.createElement('td');
      tdName.textContent = r.name || r.symbolicName;
      tdOk.textContent = fmt(r.completed||0);
      const failLink = document.createElement('a');
      failLink.href = '#';
      failLink.className = 'cpi-lite-link cpi-lite-fail';
      failLink.textContent = fmt(r.failed||0);
      failLink.addEventListener('click', (ev)=>{ ev.preventDefault(); showFailedFor(r.symbolicName || r.name, r.name || r.symbolicName); });
      tdFail.appendChild(failLink);
      tdOk.className = 'cpi-lite-count cpi-lite-ok';
      tdFail.className = 'cpi-lite-count';
      tr.appendChild(tdName);
      tr.appendChild(tdOk);
      tr.appendChild(tdFail);
      tbody.appendChild(tr);
    }
    body.appendChild(table);
    body.appendChild(pager);

    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(panel);

    // Wire controls
    const batchInput = root.querySelector('#cpi-lite-batch');
    const prev = root.querySelector('#cpi-lite-prev');
    const next = root.querySelector('#cpi-lite-next');
    const page = root.querySelector('#cpi-lite-page');
    const status = root.querySelector('#cpi-lite-status');
    const totalPages = Math.max(1, Math.ceil(rowsToRender.length / state.batchSize));
    page.textContent = `${rowsToRender.length ? state.pageIndex+1 : 0} / ${totalPages}`;
    prev.onclick = ()=>{ if (state.pageIndex>0){ state.pageIndex--; renderInPage(state.cachedRows); }};
    next.onclick = ()=>{ if ((state.pageIndex+1) < totalPages){ state.pageIndex++; renderInPage(state.cachedRows); }};
    batchInput.onchange = ()=>{
      const v = Math.max(1, parseInt(batchInput.value,10)||1);
      state.batchSize = v;
      state.pageIndex = 0;
      renderInPage(state.cachedRows);
    };
    root.querySelector('#cpi-lite-load')?.addEventListener('click', async ()=>{
      status.textContent = 'Loading...';
      try{
        const data = await collect();
        state.cachedRows = Array.isArray(data)? data : [];
        state.pageIndex = 0;
        status.textContent = `Loaded ${state.cachedRows.length} iFlows`;
        renderInPage(state.cachedRows);
      }catch(e){
        status.textContent = String(e && e.message || e);
      }
    });
  }

  function findMainContentContainer(){
    // Try a wide range of selectors used by UI5 ToolPage layouts
    const candidates = [
      // Integration Suite split app detail area (matches Sprintegrate placement)
      document.querySelector('#shell--splitApp-Detail'),
      document.querySelector('#mainPage-cont'),
      document.querySelector('#mainPage'),
      // ToolPage main content wrappers
      // Common ToolPage content wrappers
      document.querySelector('[id$="--toolPage-contentWrapper"] .sapTntToolPageContent'),
      document.querySelector('[id$="--toolPage-contentWrapper"]'),
      document.querySelector('[id$="--toolPage-content"]'),
      document.querySelector('.sapTntToolPageContent'),
      document.querySelector('.sapTntToolPageMainContent'),
      document.querySelector('.sapTntToolPageContentWrapper'),
      // Shell/App containers seen in Integration Suite
      document.querySelector('#shell--content'),
      document.querySelector('#shell--contentContainer'),
      // Fallbacks
      document.querySelector('[id$="--pageContent"]'),
      document.querySelector('.fd-tool-page__content'),
      document.querySelector('main')
    ];
    const found = candidates.find(Boolean);
    if (found) return found;
    // As a last resort, pick the largest visible container right of the side nav
    try{
      const side = document.querySelector('[id$="--sideNavigation"], .sapTntSideNavigation');
      const sideRight = side ? side.getBoundingClientRect().right : 240;
      let best = null, bestArea = 0;
      document.querySelectorAll('body > *').forEach(el=>{
        const r = el.getBoundingClientRect();
        if (r.width>400 && r.height>300 && r.left >= sideRight){
          const area = r.width*r.height;
          if (area>bestArea){ bestArea=area; best=el; }
        }
      });
      return best;
    }catch(_e){
      return null;
    }
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
    const controls = document.createElement('div');
    controls.className = 'cpi-lite-controls';
    controls.innerHTML = `
      <label>BatchSize: <input id="cpi-lite-batch" class="cpi-lite-input" type="number" min="1" step="1" value="${state.batchSize}"></label>
      <button id="cpi-lite-load" class="cpi-lite-btn">Get Message Overview</button>
      <span id="cpi-lite-status" style="margin-left:8px; color:#666;"></span>
    `;
    const table = document.createElement('table');
    table.className = 'cpi-lite-table';
    table.innerHTML = '<thead><tr><th style="width:55%">iFlow</th><th style="width:22%" class="cpi-lite-count">Completed</th><th style="width:23%" class="cpi-lite-count">Failed</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    const fmt = n=> new Intl.NumberFormat().format(n);
    const rowsToRender = Array.isArray(rows) ? rows : [];
    rowsToRender.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    const start = state.pageIndex * state.batchSize;
    const pageRows = rowsToRender.slice(start, start + state.batchSize);
    for (const r of pageRows){
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const tdOk = document.createElement('td');
      const tdFail = document.createElement('td');
      tdName.textContent = r.name || r.symbolicName;
      tdOk.textContent = fmt(r.completed||0);
      const failLink = document.createElement('a');
      failLink.href = '#';
      failLink.className = 'cpi-lite-link cpi-lite-fail';
      failLink.textContent = fmt(r.failed||0);
      failLink.addEventListener('click', (ev)=>{ ev.preventDefault(); showFailedFor(r.symbolicName || r.name, r.name || r.symbolicName); });
      tdFail.appendChild(failLink);
      tdOk.className = 'cpi-lite-count cpi-lite-ok';
      tdFail.className = 'cpi-lite-count';
      tr.appendChild(tdName);
      tr.appendChild(tdOk);
      tr.appendChild(tdFail);
      tbody.appendChild(tr);
    }
    const pager = document.createElement('div');
    pager.className = 'cpi-lite-pager';
    const totalPages = Math.max(1, Math.ceil(rowsToRender.length / state.batchSize));
    pager.innerHTML = `
      <span id="cpi-lite-prev" class="cpi-lite-link">Prev</span>
      <span id="cpi-lite-page">${rowsToRender.length ? state.pageIndex+1 : 0} / ${totalPages}</span>
      <span id="cpi-lite-next" class="cpi-lite-link">Next</span>
    `;
    page.appendChild(header);
    page.appendChild(controls);
    page.appendChild(table);
    page.appendChild(pager);
    root.appendChild(page);

    // Wire controls
    const batchInput = root.querySelector('#cpi-lite-batch');
    const status = root.querySelector('#cpi-lite-status');
    const prev = root.querySelector('#cpi-lite-prev');
    const next = root.querySelector('#cpi-lite-next');
    prev.onclick = ()=>{ if (state.pageIndex>0){ state.pageIndex--; renderFullPage(state.cachedRows); }};
    next.onclick = ()=>{
      const total = Math.max(1, Math.ceil(rowsToRender.length / state.batchSize));
      if ((state.pageIndex+1) < total){ state.pageIndex++; renderFullPage(state.cachedRows); }
    };
    batchInput.onchange = ()=>{
      const v = Math.max(1, parseInt(batchInput.value,10)||1);
      state.batchSize = v;
      state.pageIndex = 0;
      renderFullPage(state.cachedRows);
    };
    root.querySelector('#cpi-lite-load')?.addEventListener('click', async ()=>{
      status.textContent = 'Loading...';
      try{
        const data = await collect();
        state.cachedRows = Array.isArray(data)? data : [];
        state.pageIndex = 0;
        status.textContent = `Loaded ${state.cachedRows.length} iFlows`;
        renderFullPage(state.cachedRows);
      }catch(e){
        status.textContent = String(e && e.message || e);
      }
    });
  }

  function renderFailedPageFull(rows, displayName){
    ensureStyles();
    const container = findMainContentContainer();
    if (!container){ renderInPage([]); return; }
    let root = container.querySelector('#cpi-lite-page-root');
    if (!root){ root = document.createElement('div'); root.id='cpi-lite-page-root'; container.appendChild(root); }
    root.className = isDark() ? 'cpi-lite-dark' : '';
    root.innerHTML = '';

    const page = document.createElement('section');
    page.className = 'cpi-lite-body';
    const header = document.createElement('div');
    header.className = 'cpi-lite-header';
    const back = document.createElement('button');
    back.className = 'cpi-lite-back';
    back.textContent = '← Back';
    back.onclick = ()=>{ renderFullPage(state.cachedRows); activateFullPageMode(); };
    const title = document.createElement('div');
    title.className = 'cpi-lite-title';
    title.textContent = `Failed Messages — ${displayName}`;
    header.appendChild(back);
    header.appendChild(title);

    const table = document.createElement('table');
    table.className = 'cpi-lite-table';
    table.innerHTML = '<thead><tr><th style="width:30%">Message ID</th><th style="width:12%" class="cpi-lite-count">Status</th><th style="width:58%">Error Details</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    for (const m of rows){
      const tr = document.createElement('tr');
      const tdId = document.createElement('td');
      const tdStatus = document.createElement('td');
      const tdErr = document.createElement('td');
      tdId.textContent = m.messageId || '';
      tdStatus.textContent = m.status || '';
      tdStatus.className = 'cpi-lite-count cpi-lite-fail';
      tdErr.textContent = m.errorDetails || m.errorText || '';
      tr.appendChild(tdId); tr.appendChild(tdStatus); tr.appendChild(tdErr);
      tbody.appendChild(tr);
    }
    page.appendChild(header);
    page.appendChild(table);
    root.appendChild(page);
  }

  function renderFailedPagePanel(rows, displayName){
    ensureStyles();
    const rootId = 'cpi-lite-panel-root';
    let root = document.getElementById(rootId);
    if (!root){ root = document.createElement('div'); root.id=rootId; document.body.appendChild(root); }
    root.className = isDark() ? 'cpi-lite-dark' : '';
    root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'cpi-lite-panel';
    const header = document.createElement('div');
    header.className = 'cpi-lite-header';
    const back = document.createElement('button');
    back.className = 'cpi-lite-back';
    back.textContent = '← Back';
    back.onclick = ()=>{ renderInPage(state.cachedRows); };
    const title = document.createElement('div');
    title.className = 'cpi-lite-title';
    title.textContent = `Failed Messages — ${displayName}`;
    header.appendChild(back);
    header.appendChild(title);
    const body = document.createElement('div');
    body.className = 'cpi-lite-body';
    const table = document.createElement('table');
    table.className = 'cpi-lite-table';
    table.innerHTML = '<thead><tr><th style="width:30%">Message ID</th><th style="width:12%" class="cpi-lite-count">Status</th><th style="width:58%">Error Details</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    for (const m of rows){
      const tr = document.createElement('tr');
      const tdId = document.createElement('td');
      const tdStatus = document.createElement('td');
      const tdErr = document.createElement('td');
      tdId.textContent = m.messageId || '';
      tdStatus.textContent = m.status || '';
      tdStatus.className = 'cpi-lite-count cpi-lite-fail';
      tdErr.textContent = m.errorDetails || m.errorText || '';
      tr.appendChild(tdId); tr.appendChild(tdStatus); tr.appendChild(tdErr);
      tbody.appendChild(tr);
    }
    body.appendChild(table);
    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(panel);
  }

  async function showFailedFor(symbolicName, displayName){
    const main = findMainContentContainer();
    try{
      if (main){
        renderFailedPageFull([], displayName);
        activateFullPageMode();
        const list = await listFailedMessagesForIflow(symbolicName, 500);
        renderFailedPageFull(list, displayName);
        activateFullPageMode();
      } else {
        renderFailedPagePanel([], displayName);
        const list = await listFailedMessagesForIflow(symbolicName, 500);
        renderFailedPagePanel(list, displayName);
      }
    }catch(e){
      const errRow = [{ messageId:'', status:'FAILED', errorText: String(e && e.message || e) }];
      if (main){ renderFailedPageFull(errRow, displayName); activateFullPageMode(); }
      else { renderFailedPagePanel(errRow, displayName); }
    }
  }

  function findSplitDetailContainer(){
    // Preferred host content area where Sprintegrate injects
    const detail = document.querySelector('#shell--splitApp-Detail');
    if (detail) return detail;
    const mainCont = document.querySelector('#mainPage-cont');
    return mainCont ? mainCont : null;
  }

  function activateFullPageMode(){
    const detail = findSplitDetailContainer();
    if (!detail) return false;
    // Hide all other top-level children while our page is active
    Array.from(detail.children).forEach((child)=>{
      if (child.id !== 'cpi-lite-page-root') child.classList.add('cpi-lite-hidden');
    });
    return true;
  }

  function deactivateFullPageMode(){
    const detail = findSplitDetailContainer();
    if (!detail) return;
    Array.from(detail.children).forEach((child)=> child.classList.remove('cpi-lite-hidden'));
    const root = document.getElementById('cpi-lite-page-root');
    if (root) root.remove();
  }

  async function openInPage(){
    try{
      const main = findMainContentContainer();
      if (main){
        // Remove any existing floating panel when switching to full-page embed
        const floatRoot = document.getElementById('cpi-lite-panel-root');
        if (floatRoot) floatRoot.remove();
        // Initial skeleton while data loads
        state.cachedRows = [];
        state.pageIndex = 0;
        renderFullPage([]);
        activateFullPageMode();
        // Wait for user to click 'Get Message Overview'
      } else {
        // Fallback: show floating right-side panel
        state.cachedRows = [];
        state.pageIndex = 0;
        renderInPage([]);
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
    item.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); openInPage(); });

    // Deactivate our page when another side-nav item is clicked
    parent.addEventListener('click', (e)=>{
      if (!item.contains(e.target)){
        deactivateFullPageMode();
      }
    });

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

    // Hide our page on URL/navigation changes
    window.addEventListener('hashchange', deactivateFullPageMode);
    window.addEventListener('popstate', deactivateFullPageMode);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
