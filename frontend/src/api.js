const API_BASE = "http://localhost:8000";

async function parseError(res, fallback) {
  try {
    const body = await res.json();
    if (body.detail) return typeof body.detail === "string" ? body.detail : fallback;
  } catch {
    /* response had no JSON body */
  }
  return `${fallback} (server returned ${res.status})`;
}

export async function uploadFiles(files, language = "auto") {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  formData.append("language", language);

  const res = await fetch(`${API_BASE}/api/files/upload`, { method: "POST", body: formData });
  if (!res.ok) throw new Error(await parseError(res, "Upload failed"));
  const data = await res.json();
  return data.results;
}

export async function listFiles() {
  const res = await fetch(`${API_BASE}/api/files`);
  if (!res.ok) throw new Error(await parseError(res, "Could not load files"));
  const data = await res.json();
  return data.files;
}

export async function getPages(fileId) {
  const res = await fetch(`${API_BASE}/api/files/${fileId}/pages`);
  if (!res.ok) throw new Error(await parseError(res, "Could not load extracted text"));
  return res.json();
}

export async function getChunks(fileId) {
  const res = await fetch(`${API_BASE}/api/files/${fileId}/chunks`);
  if (!res.ok) throw new Error(await parseError(res, "Could not load chunks"));
  return res.json();
}

export async function reprocessFile(fileId, language) {
  const query = language ? `?language=${encodeURIComponent(language)}` : "";
  const res = await fetch(`${API_BASE}/api/files/${fileId}/reprocess${query}`, { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res, "Could not restart processing"));
  return res.json();
}

export function originalUrl(fileId) {
  return `${API_BASE}/api/files/${fileId}/original`;
}

export async function searchChunks(query, k = 5) {
  const params = new URLSearchParams({ q: query, k: String(k) });
  const res = await fetch(`${API_BASE}/api/search?${params}`);
  if (!res.ok) throw new Error(await parseError(res, "Search failed"));
  const data = await res.json();
  return data.results;
}

export async function askQuestion(question, fileIds, answerLanguage = "auto") {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, file_ids: fileIds, answer_language: answerLanguage }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not get an answer"));
  return res.json();
}

export async function getUsage() {
  const res = await fetch(`${API_BASE}/api/chat/usage`);
  if (!res.ok) throw new Error("usage unavailable");
  return res.json();
}