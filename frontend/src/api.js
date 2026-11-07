// Backend URL comes from the env file Vite picks for the current mode:
//   npm run dev   -> .env.development (local backend)
//   npm run build -> .env.production  (cloud backend)
// Vite only exposes variables prefixed with VITE_, via import.meta.env (process.env does not exist in the browser).
const API_BASE = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, "");

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

export async function getFile(fileId) {
  const res = await fetch(`${API_BASE}/api/files/${fileId}`);
  if (!res.ok) throw new Error(await parseError(res, "Could not load file"));
  return res.json();
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

export async function askQuestion(question, fileIds = null, answerLanguage = "auto", conversationId = null) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      file_ids: fileIds && fileIds.length > 0 ? fileIds : null,
      answer_language: answerLanguage,
      conversation_id: conversationId,
    }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not get an answer"));
  return res.json();
}

// ---- Chat sessions ----
export async function listConversations() {
  const res = await fetch(`${API_BASE}/api/conversations`);
  if (!res.ok) throw new Error(await parseError(res, "Could not load chats"));
  const data = await res.json();
  return data.conversations;
}

export async function createConversation() {
  const res = await fetch(`${API_BASE}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not start a chat"));
  return res.json();
}

export async function getConversation(conversationId) {
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}`);
  if (!res.ok) throw new Error(await parseError(res, "Could not load chat"));
  return res.json();
}

export async function updateConversation(conversationId, changes) {
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not update chat"));
  return res.json();
}

export async function deleteConversation(conversationId) {
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res, "Could not delete chat"));
  return res.json();
}

export async function attachFileToConversation(conversationId, fileId) {
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) throw new Error(await parseError(res, "Could not attach document"));
  return res.json();
}

export async function getUsage() {
  const res = await fetch(`${API_BASE}/api/chat/usage`);
  if (!res.ok) throw new Error("usage unavailable");
  return res.json();
}
