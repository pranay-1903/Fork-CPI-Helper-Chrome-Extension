'use strict';
// Exposes minimal bridge for popup via chrome.storage.local syncing fetched data
// Detect tenant and urlExtension like original
(function(){
  const state = {
    tenant: location.host,
    urlExtension: '',
    knownArtifacts: [],
    counts: {}, // { [symbolicName]: { completed: number, failed: number } }
    lastUpdated: null
  };

  const cpiTypeRegexp = /^[^\/]*\.integrationsuite(-trial)?.*/;
  if (!document.location.host.match(cpiTypeRegexp)) {
    state.urlExtension = 'itspaces/';
  }

  function absolutePath(href){
    const a = document.createElement('a');
    a.href = href;
    return a.protocol + '//' + a.host + a.pathname + a.search + a.hash;
  }

  function xhrPromise(method, url, headers) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, absolutePath(url));
      xhr.withCredentials = true;
      if (headers) {
        Object.entries(headers).forEach(([k,v])=>xhr.setRequestHeader(k, v));
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
        reject(new Error('HTTP '+xhr.status+' '+xhr.statusText));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send();
    });
  }

  async function loadKnownArtifacts(){
    const url = `/${state.urlExtension}Operations/com.sap.it.op.tmn.commands.dashboard.webui.KnownArtifactsListCommand`;
    const xml = await xhrPromise('GET', url);
    const parsed = new XmlToJson().parse(xml);
    const root = parsed['com.sap.it.op.tmn.commands.dashboard.webui.KnownArtifactsListResponse'];
    const list = root && root.knownArtifacts ? root.knownArtifacts : [];
    const arr = Array.isArray(list) ? list : [list];
    // Normalize minimal fields used
    state.knownArtifacts = arr.filter(Boolean).map(e=>({
      name: e.name && e.name['#text'] ? e.name['#text'] : e.name,
      symbolicName: e.symbolicName && e.symbolicName['#text'] ? e.symbolicName['#text'] : e.symbolicName
    })).filter(x=>x.symbolicName);
  }

  // Time window: mimic current behavior -> list "last" set by UI; here we approximate by recent (top N) per iflow using OData ordering
  async function countFor(symbolicName){
    // recent messages: same query style as original (orderby LogEnd desc, top=35)
    const base = `/${state.urlExtension}odata/api/v1/MessageProcessingLogs?$format=json&$orderby=LogEnd desc&$top=200&$select=Status,IntegrationFlowName`;
    const filter = `&$filter=IntegrationFlowName eq '${symbolicName}' and Status ne 'DISCARDED'`;
    const res = JSON.parse(await xhrPromise('GET', base+filter));
    const results = (res && res.d && res.d.results) ? res.d.results : [];
    let completed=0, failed=0;
    for(const r of results){
      if (r.Status === 'COMPLETED') completed++;
      else if (r.Status === 'FAILED') failed++;
    }
    return { completed, failed };
  }

  async function refresh(){
    try{
      await loadKnownArtifacts();
      const counts = {};
      // Keep list small for performance in popup. We count for first 100 artifacts.
      const slice = state.knownArtifacts.slice(0, 100);
      await Promise.all(slice.map(async a=>{ counts[a.symbolicName] = await countFor(a.symbolicName); }));
      state.counts = counts;
      state.lastUpdated = new Date().toISOString();
      await chrome.storage.local.set({ 'cpi-resender:data': { tenant: state.tenant, urlExtension: state.urlExtension, artifacts: slice, counts, lastUpdated: state.lastUpdated }});
    }catch(e){
      await chrome.storage.local.set({ 'cpi-resender:error': String(e && e.message || e) });
    }
  }

  // initial sync and periodic refresh
  refresh();
  setInterval(refresh, 60*1000);
})();
