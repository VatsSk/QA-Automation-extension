// ─── api-client.js ───────────────────────────────────────────────────────────
const API_BASE_URL = 'http://3.7.136.248:8088'; // TODO: Make configurable, env var, or detect from context

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
  }
};
