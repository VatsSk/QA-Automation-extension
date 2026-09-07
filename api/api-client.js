// ─── api-client.js ───────────────────────────────────────────────────────────

// 'http://3.7.136.248:8088'
// const API_BASE_URL = 'http://localhost:8088';
const API_BASE_URL = 'http://3.7.136.248:8088';
 // TODO: Make configurable, env var, or detect from context

const ApiClient = {
  async saveRun({ projectId, moduleId, authToken, payload }) {
    if (!projectId || !moduleId) {
      throw new Error('Cannot save run: Project ID or Module ID is missing.');
    }

    const res = await fetch(`${API_BASE_URL}/api/projects/${projectId}/modules/${moduleId}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err}`);
    }

    return res.json();
  },

  async updateRun({ projectId, moduleId, runId, authToken, payload }) {
    if (!projectId || !moduleId || !runId) {
      throw new Error('Cannot update run: Project ID, Module ID or Run ID is missing.');
    }

    const res = await fetch(`${API_BASE_URL}/api/runs/${runId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err}`);
    }

    return res.json();
  },

  async uploadCsv({ projectId, moduleId, runId = '', sequenceNo, file, authToken }) {
    const form = new FormData();
    form.append('file', file);
    form.append('projectId', projectId);
    form.append('moduleId', moduleId);
    form.append('runId', runId);
    form.append('sequenceNo', String(sequenceNo));

    const res = await fetch(`${API_BASE_URL}/api/uploads/testcase`, {
      method: 'POST',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: form
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Upload failed (${res.status}): ${err}`);
    }
    return res.json(); // Expected: { path, url, filename, sizeBytes }
  },

  // ── Flow API ────────────────────────────────────────────────────────────────

  async saveFlowDraft({ authToken, payload }) {
    const res = await fetch(`${API_BASE_URL}/api/flows/draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err}`);
    }
    return res.json();
  },

  async updateFlowDraft({ flowId, authToken, payload }) {
    payload.id = flowId; // Ensure the payload has the flow ID
    if (!flowId) {
      throw new Error('Cannot update flow: Flow ID is missing.');
    }

    const res = await fetch(`${API_BASE_URL}/api/flows/${flowId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify(payload)

    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err}`);
    }
    return res.json();
  }
};

const request = async (method, endpoint, data, authToken) => {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        ...(data ? { body: JSON.stringify(data) } : {})
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`API ${res.status}: ${err}`);
    }
    return res.json();
};

const components = {
    listModules: (projectId, authToken) => request('GET', `/api/components/modules/${projectId}`, null, authToken),
    createModule: (data, authToken) => request('POST', `/api/components/modules`, data, authToken),
    listComponents: (projectId, moduleId, authToken) => request('GET', `/api/components/${projectId}/${moduleId}`, null, authToken),
    createComponent: (data, authToken) => request('POST', `/api/components`, data, authToken),
    updateComponent: (id, data, authToken) => request('PUT', `/api/components/${id}`, data, authToken),
    getFlowInfo: (flowId, authToken) => request('GET', `/api/components/flow-info/${flowId}`, null, authToken),
    saveFlowInfo: (flowId, data, authToken) => request('PUT', `/api/components/flow-info/${flowId}`, data, authToken)
};

window.components = components;
