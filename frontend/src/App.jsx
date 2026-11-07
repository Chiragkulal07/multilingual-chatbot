import { useCallback, useEffect, useRef, useState } from "react";
import {
  askQuestion,
  attachFileToConversation,
  createConversation,
  deleteConversation,
  getConversation,
  getFile,
  listConversations,
  originalUrl,
  reprocessFile,
  updateConversation,
  uploadFiles,
} from "./api";
import { renderMarkdown } from "./markdown.jsx";
import "./App.css";

const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".pdf"];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
// OCR on a large or multi-page scan can take minutes on CPU; keep polling that long.
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const STILL_PROCESSING_TEXT = (name) =>
  `${name} is still being processed. It will appear in your files when it is ready; you can retry from there.`;

function precheck(file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return "Unsupported file type. Allowed: PDF, PNG, JPG, JPEG.";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_SIZE) return "File exceeds the 10 MB limit.";
  return null;
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const THINK_PHASES_DOC = [
  "Reading the document",
  "Finding relevant passages",
  "Cross-checking details",
  "Composing the answer",
];
const THINK_PHASES_CHAT = ["Understanding the question", "Reasoning it through", "Composing the answer"];

// Convert stored backend messages into the shape the thread renders.
function fromStoredMessage(m) {
  const meta = m.meta || {};
  if (m.kind === "file") {
    return {
      id: `db-${m.id}`,
      role: "assistant",
      isFileAttached: true,
      stage: "ready",
      text: m.content,
      fileInfo: {
        id: meta.file_id,
        name: meta.filename,
        size: meta.size_bytes,
        type: (meta.file_type || "").toUpperCase(),
        isImage: meta.file_type !== "pdf",
        detected_language: meta.detected_language,
      },
    };
  }
  if (m.role === "user") {
    return {
      id: `db-${m.id}`,
      role: "user",
      text: m.content,
      attachedFile: meta.attached_filename ? { name: meta.attached_filename } : null,
    };
  }
  return {
    id: `db-${m.id}`,
    role: "assistant",
    text: m.content,
    sources: meta.sources || [],
    fromDocuments: meta.from_documents,
  };
}

// Bucket chats by last activity, like ChatGPT / Claude.
function groupConversations(list) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const buckets = [
    { label: "Today", after: startOfToday.getTime(), items: [] },
    { label: "Yesterday", after: startOfToday.getTime() - day, items: [] },
    { label: "Previous 7 days", after: startOfToday.getTime() - 7 * day, items: [] },
    { label: "Previous 30 days", after: startOfToday.getTime() - 30 * day, items: [] },
    { label: "Older", after: -Infinity, items: [] },
  ];
  for (const c of list) {
    const t = new Date(c.updated_at).getTime();
    buckets.find((b) => t >= b.after).items.push(c);
  }
  return buckets.filter((b) => b.items.length > 0);
}

function readConversationFromUrl() {
  return new URLSearchParams(window.location.search).get("c");
}

function writeConversationToUrl(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("c", id);
  else url.searchParams.delete("c");
  window.history.replaceState(null, "", url);
}

/* Brand monogram: a page whose lines resolve into a highlighted passage. */
function BrandGlyph({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 3.5h8.2L19 8.3V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1-1.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M14 3.6V8.5h4.9" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8.5 12h7M8.5 15.5h4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="16.4" cy="15.5" r="1.25" fill="var(--brass)" />
    </svg>
  );
}

function AssistantMark({ thinking = false }) {
  return (
    <div className={`assistant-avatar ${thinking ? "is-thinking" : ""}`} aria-hidden="true">
      <BrandGlyph size={15} />
    </div>
  );
}

// Reveals a finished answer progressively, like a streamed response.
function StreamedText({ text, animate, onTick, onDone }) {
  const [shown, setShown] = useState(animate ? 0 : text.length);
  const done = shown >= text.length;

  useEffect(() => {
    if (!animate || done) return undefined;
    const total = text.length;
    // Total reveal time scales with length but stays between 0.6s and 3.2s.
    const duration = Math.min(3200, Math.max(600, total * 14));
    let start = null;
    let frame;
    const step = (now) => {
      if (start === null) start = now;
      const progress = Math.min(1, (now - start) / duration);
      // Ease-out so the tail lands softly.
      const eased = 1 - Math.pow(1 - progress, 1.6);
      setShown(Math.floor(eased * total));
      onTick?.();
      if (progress < 1) frame = requestAnimationFrame(step);
      else onDone?.();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, text]);

  const visible = done ? text : text.slice(0, shown);
  return (
    <div className={`assistant-text-content ${done ? "" : "is-streaming"}`}>
      {renderMarkdown(visible)}
    </div>
  );
}

function ThinkingIndicator({ hasDocument }) {
  const phases = hasDocument ? THINK_PHASES_DOC : THINK_PHASES_CHAT;
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setPhase((p) => Math.min(p + 1, phases.length - 1));
    }, 1700);
    return () => clearInterval(timer);
  }, [phases.length]);

  return (
    <div className="message-turn assistant-turn thinking-turn" role="status" aria-live="polite">
      <AssistantMark thinking />
      <div className="assistant-body thinking-body">
        <div className="thinking-status">
          <span key={phase} className="thinking-phase">
            {phases[phase]}
          </span>
          <span className="thinking-ellipsis">
            <i></i>
            <i></i>
            <i></i>
          </span>
        </div>
        <div className="thinking-skeleton">
          <span style={{ width: "94%" }}></span>
          <span style={{ width: "81%" }}></span>
          <span style={{ width: "62%" }}></span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [activeFile, setActiveFile] = useState(null); // currently attached document
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [language, setLanguage] = useState("auto");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState({});

  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const isUploadingRef = useRef(false);
  // Which chat is on screen right now; async work checks it before touching the thread.
  const activeConvRef = useRef(null);
  // Bumped whenever the visible thread is swapped (new chat / open chat).
  const threadEpochRef = useRef(0);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, uploading]);

  const selectConversationId = (id) => {
    activeConvRef.current = id;
    setConversationId(id);
    writeConversationToUrl(id);
  };

  // Load chat sessions list
  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      // Backend may be offline
    }
  }, []);

  const openConversation = useCallback(async (id) => {
    threadEpochRef.current += 1;
    activeConvRef.current = id;
    setLoading(false);
    setConversationId(id);
    writeConversationToUrl(id);
    setLoadingConversation(true);
    setMessages([]);
    setActiveFile(null);
    setDetailsOpen({});
    try {
      const data = await getConversation(id);
      if (activeConvRef.current !== id) return;
      setMessages(data.messages.map(fromStoredMessage));
      setActiveFile(data.active_file);
    } catch {
      if (activeConvRef.current !== id) return;
      // Chat no longer exists (deleted, or a stale link) — fall back to a fresh one.
      activeConvRef.current = null;
      setConversationId(null);
      writeConversationToUrl(null);
    } finally {
      if (activeConvRef.current === id || activeConvRef.current === null) setLoadingConversation(false);
    }
  }, []);

  useEffect(() => {
    refreshConversations();
    const fromUrl = readConversationFromUrl();
    if (fromUrl) openConversation(fromUrl);
  }, [refreshConversations, openConversation]);

  // Returns the current chat's id, creating the session on the backend if needed.
  const ensureConversation = async () => {
    if (activeConvRef.current) return activeConvRef.current;
    const conv = await createConversation();
    selectConversationId(conv.conversation_id);
    return conv.conversation_id;
  };

  const handleDetach = () => {
    setActiveFile(null);
    if (conversationId) {
      updateConversation(conversationId, { detach_file: true })
        .then(refreshConversations)
        .catch(() => {});
    }
  };

  const handleDeleteConversation = async (id) => {
    if (!window.confirm("Delete this chat? This cannot be undone.")) return;
    try {
      await deleteConversation(id);
    } catch {
      return;
    }
    if (activeConvRef.current === id) handleNewChat();
    refreshConversations();
  };

  const startRename = (c) => {
    setRenamingId(c.conversation_id);
    setRenameValue(c.title);
  };

  const commitRename = async () => {
    const id = renamingId;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!id || !title) return;
    setConversations((prev) => prev.map((c) => (c.conversation_id === id ? { ...c, title } : c)));
    try {
      await updateConversation(id, { title });
    } finally {
      refreshConversations();
    }
  };

  // Auto-resize input textarea
  const handleInputChange = (e) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  };

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleDetails = (id) => {
    setDetailsOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Upload and process a file with live backend stage tracking
  const handleUploadFile = async (file) => {
    if (isUploadingRef.current) return;

    const errorMsg = precheck(file);
    if (errorMsg) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          role: "assistant",
          text: `Upload error: ${errorMsg}`,
          isError: true,
        },
      ]);
      return;
    }

    const tempId = Date.now();
    isUploadingRef.current = true;
    setUploading(true);

    let cid;
    try {
      cid = await ensureConversation();
    } catch (e) {
      isUploadingRef.current = false;
      setUploading(false);
      setMessages((prev) => [
        ...prev,
        { id: tempId, role: "assistant", text: `Upload failed: ${e.message}`, isError: true },
      ]);
      return;
    }

    const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png)$/i.test(file.name);
    const localPreviewUrl = isImage ? URL.createObjectURL(file) : null;

    // Immediately insert animated processing card into chat stream
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        role: "assistant",
        isProcessing: true,
        fileInfo: {
          name: file.name,
          size: file.size,
          type: file.name.split(".").pop().toUpperCase(),
          isImage,
          previewUrl: localPreviewUrl,
        },
        stage: "uploading",
        stageText: "Uploading file…",
      },
    ]);

    try {
      const results = await uploadFiles([file], language);
      const uploaded = results[0];

      if (uploaded.status === "rejected") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? {
                  ...m,
                  isProcessing: false,
                  stage: "failed",
                  isError: true,
                  text: `Could not process ${file.name}: ${uploaded.error}`,
                }
              : m
          )
        );
        isUploadingRef.current = false;
        setUploading(false);
        return;
      }

      const fileId = uploaded.file_id;

      // Poll real backend stages from /api/files/{file_id}
      let isDone = false;
      const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

      while (!isDone && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 900));
        try {
          const detail = await getFile(fileId);
          const currentStage = detail.stage || detail.status;

          // Determine stage text based on file type and real backend stage
          let stageLabel = "Analyzing…";
          if (currentStage === "analyzing") {
            stageLabel = isImage ? "Analyzing image…" : "Reading document…";
          } else if (currentStage === "extracting") {
            stageLabel = "Extracting content…";
          } else if (currentStage === "preparing_context") {
            stageLabel = "Preparing document context…";
          } else if (currentStage === "ready") {
            stageLabel = "Document ready";
          }

          if (detail.status === "ready") {
            isDone = true;
            await attachFileToConversation(cid, fileId).catch(() => {});
            if (activeConvRef.current === cid) setActiveFile(detail);
            refreshConversations();

            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...m,
                      isProcessing: false,
                      isFileAttached: true,
                      stage: "ready",
                      stageText: "Document ready",
                      fileInfo: {
                        ...m.fileInfo,
                        id: fileId,
                        detected_language: detail.detected_language,
                      },
                      text: `${file.name} has been analyzed and indexed. You can now ask questions about it.`,
                    }
                  : m
              )
            );
            break;
          } else if (detail.status === "failed") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...m,
                      isProcessing: false,
                      stage: "failed",
                      isError: true,
                      fileId,
                      text: `Failed to process ${file.name}: ${detail.error_message || "Recognition error."}`,
                    }
                  : m
              )
            );
            isDone = true;
            break;
          } else {
            // Update live stage in chat UI
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...m,
                      stage: currentStage,
                      stageText: stageLabel,
                    }
                  : m
              )
            );
          }
        } catch {
          // Retry poll
        }
      }
      if (!isDone) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? { ...m, isProcessing: false, stage: "failed", isError: true, fileId, text: STILL_PROCESSING_TEXT(file.name) }
              : m
          )
        );
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId
            ? {
                ...m,
                isProcessing: false,
                stage: "failed",
                isError: true,
                text: `Upload failed: ${e.message}`,
              }
            : m
        )
      );
    } finally {
      isUploadingRef.current = false;
      setUploading(false);
    }
  };

  // Retry processing a failed file
  const handleRetryProcessing = async (messageId, fileId, filename) => {
    if (!fileId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              isProcessing: true,
              isError: false,
              stage: "analyzing",
              stageText: "Reading content…",
            }
          : m
      )
    );
    setUploading(true);
    const cid = activeConvRef.current;

    try {
      await reprocessFile(fileId, language);
      let isDone = false;
      const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

      while (!isDone && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1000));
        const detail = await getFile(fileId);
        if (detail.status === "ready") {
          isDone = true;
          if (cid) await attachFileToConversation(cid, fileId).catch(() => {});
          if (activeConvRef.current === cid) setActiveFile(detail);
          refreshConversations();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    isProcessing: false,
                    stage: "ready",
                    stageText: "Document ready",
                    isFileAttached: true,
                    text: `${filename} has been reprocessed. You can now ask questions about it.`,
                  }
                : m
            )
          );
          break;
        } else if (detail.status === "failed") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    isProcessing: false,
                    stage: "failed",
                    isError: true,
                    text: `Reprocessing failed: ${detail.error_message || "Error"}`,
                  }
                : m
            )
          );
          isDone = true;
          break;
        }
      }
      if (!isDone) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, isProcessing: false, stage: "failed", isError: true, text: STILL_PROCESSING_TEXT(filename) }
              : m
          )
        );
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                isProcessing: false,
                stage: "failed",
                isError: true,
                text: `Retry failed: ${e.message}`,
              }
            : m
        )
      );
    } finally {
      setUploading(false);
    }
  };

  // Send message
  const handleSend = async (overrideText) => {
    const question = (overrideText || input).trim();
    if (!question || loading || uploading) return;

    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const userMessageId = Date.now();
    const newUserMsg = {
      id: userMessageId,
      role: "user",
      text: question,
      attachedFile: activeFile ? { name: activeFile.filename } : null,
    };

    setMessages((prev) => [...prev, newUserMsg]);
    setLoading(true);

    // Conversation memory lives on the backend; a new session is created on the first message.
    const sentFrom = activeConvRef.current;
    const epoch = threadEpochRef.current;

    try {
      const fileIds = activeFile ? [activeFile.file_id] : null;
      const res = await askQuestion(question, fileIds, language, sentFrom);
      refreshConversations();

      if (threadEpochRef.current !== epoch) return; // user switched chats meanwhile
      if (!sentFrom && res.conversation_id) selectConversationId(res.conversation_id);

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          text: res.answer,
          sources: res.sources || [],
          fromDocuments: res.from_documents,
          cached: res.cached,
          animate: true,
        },
      ]);
    } catch (e) {
      if (threadEpochRef.current !== epoch) return;
      const errText =
        e.message === "Failed to fetch"
          ? "Unable to reach the server. Make sure the backend is running."
          : e.message;
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          text: errText,
          isError: true,
        },
      ]);
    } finally {
      if (threadEpochRef.current === epoch) setLoading(false);
    }
  };

  function handleNewChat() {
    threadEpochRef.current += 1;
    selectConversationId(null);
    setMessages([]);
    setActiveFile(null);
    setInput("");
    setDetailsOpen({});
    setLoading(false);
    setLoadingConversation(false);
    setSidebarOpen(false);
  }

  // Drag and drop handler
  const [dragging, setDragging] = useState(false);
  const handleDragOver = (e) => {
    e.preventDefault();
    setDragging(true);
  };
  const handleDragLeave = () => {
    setDragging(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUploadFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div
      className={`chat-app-root ${dragging ? "file-drag-active" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Left Sidebar: chat history */}
      <aside className={`chat-sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <BrandGlyph size={17} />
            </span>
            <span className="brand-name">DocuSense</span>
          </div>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} title="Close sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="sidebar-actions">
          <button className="new-chat-btn" onClick={handleNewChat}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New chat</span>
          </button>
        </div>

        <nav className="sidebar-content" aria-label="Chat history">
          {conversations.length === 0 ? (
            <p className="sidebar-empty">Your chats will appear here.</p>
          ) : (
            groupConversations(conversations).map((group) => (
              <div key={group.label} className="conv-group">
                <div className="sidebar-section-title">
                  <span>{group.label}</span>
                </div>
                <ul className="conv-list">
                  {group.items.map((c) => {
                    const isCurrent = c.conversation_id === conversationId;
                    const isRenaming = renamingId === c.conversation_id;
                    return (
                      <li
                        key={c.conversation_id}
                        className={`conv-item ${isCurrent ? "conv-item-active" : ""}`}
                        onClick={() => {
                          if (isRenaming) return;
                          if (!isCurrent) openConversation(c.conversation_id);
                          setSidebarOpen(false);
                        }}
                      >
                        {isRenaming ? (
                          <input
                            className="conv-rename-input"
                            value={renameValue}
                            autoFocus
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                          />
                        ) : (
                          <>
                            <span className="conv-title" title={c.title}>
                              {c.title}
                            </span>
                            <span className="conv-actions">
                              <button
                                className="conv-action-btn"
                                title="Rename"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startRename(c);
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                              </button>
                              <button
                                className="conv-action-btn conv-action-danger"
                                title="Delete"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteConversation(c.conversation_id);
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6M14 11v6" />
                                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                                </svg>
                              </button>
                            </span>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </nav>
      </aside>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}

      {/* Main Chat Area */}
      <div className="chat-main-container">
        {/* Top Navbar */}
        <header className="chat-navbar">
          <div className="navbar-left">
            <button
              className="nav-icon-btn sidebar-toggle"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title="Toggle sidebar"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            <span className="navbar-title">
              {activeFile ? (
                <span className="active-doc-badge">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="doc-badge-name">{activeFile.filename}</span>
                  <button
                    className="detach-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDetach();
                    }}
                    title="Detach document (Switch to normal chat)"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </span>
              ) : (
                <span className="navbar-context">
                  {conversations.find((c) => c.conversation_id === conversationId)?.title || "New chat"}
                </span>
              )}
            </span>
          </div>

          <div className="navbar-right">
            <select
              className="nav-language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              title="Response Language"
            >
              <option value="auto">Auto Language</option>
              <option value="en">English</option>
              <option value="hi">हिन्दी (Hindi)</option>
              <option value="kn">ಕನ್ನಡ (Kannada)</option>
            </select>

            <button className="nav-new-chat-btn" onClick={handleNewChat} title="New chat">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Message Thread */}
        <main className="chat-messages-scroll">
          <div className="chat-thread-inner">
            {loadingConversation ? (
              <div className="conv-loading" role="status">
                <span></span>
                <span></span>
                <span></span>
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-empty-state">
                <p className="empty-eyebrow">
                  <span className="eyebrow-dot" aria-hidden="true"></span>
                  Document intelligence
                  <span className="eyebrow-langs" lang="mul">English · हिन्दी · ಕನ್ನಡ</span>
                </p>
                <h1 className="empty-heading">
                  Read any document.
                  <em> Ask it anything.</em>
                </h1>
                <p className="empty-subheading">
                  Scans, photos and PDFs are read with OCR, indexed, and answered with the passages they came from.
                </p>

                <button
                  type="button"
                  className="empty-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <span className="dropzone-icon" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 15V4" />
                      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
                      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
                    </svg>
                  </span>
                  <span className="dropzone-copy">
                    <span className="dropzone-title">
                      Drop a document here, or <u>browse</u>
                    </span>
                    <span className="dropzone-meta">PDF, PNG or JPG · up to 10 MB · handwriting and scans welcome</span>
                  </span>
                </button>

                <div className="empty-suggestions-grid" role="list" aria-label="Suggested prompts">
                  <span className="suggestions-label">Or start with</span>
                  {[
                    ["Summarize the key points", "Summarize the key information in this document"],
                    ["Extract dates, figures and amounts", "Extract all dates, figures, and amounts"],
                    ["What is the capital of Karnataka?", "What is the capital of Karnataka and what is it known for?"],
                  ].map(([label, prompt]) => (
                    <button key={label} role="listitem" className="suggestion-box" onClick={() => handleSend(prompt)}>
                      <span className="suggestion-text">{label}</span>
                      <svg className="suggestion-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                // User Message
                if (m.role === "user") {
                  return (
                    <div key={m.id} className="message-turn user-turn">
                      <div className="bubble user-bubble">
                        {m.attachedFile && (
                          <div className="attached-file-pill">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span>{m.attachedFile.name}</span>
                          </div>
                        )}
                        <div className="bubble-text">{m.text}</div>
                      </div>
                    </div>
                  );
                }

                // File Upload Card with Animated Scanning Effect
                if (m.fileInfo) {
                  const isScanning = m.isProcessing;
                  const isDone = m.stage === "ready";
                  const isFail = m.stage === "failed" || m.isError;
                  const isImg = m.fileInfo.isImage;

                  return (
                    <div key={m.id} className="message-turn assistant-turn">
                      <AssistantMark />
                      <div className="assistant-body file-process-bubble">
                        {/* 1. Image Preview with Active Laser Scanning Effect */}
                        {isImg ? (
                          <div className={`scan-card-image-wrap ${isScanning ? "is-scanning" : ""} ${isDone ? "is-ready" : ""}`}>
                            <div className="image-viewport-container">
                              <img
                                src={m.fileInfo.previewUrl || (m.fileInfo.id ? originalUrl(m.fileInfo.id) : "")}
                                alt={m.fileInfo.name}
                                className="scanned-image-preview"
                              />

                              {/* Horizontal laser scanning line moving top-to-bottom */}
                              {isScanning && <div className="scanning-laser-line" aria-hidden="true"></div>}
                            </div>
                          </div>
                        ) : (
                          /* 2. PDF Document Card with Animated Page-Scanning Effect */
                          <div className={`scan-card-pdf-wrap ${isScanning ? "is-scanning-pdf" : ""} ${isDone ? "is-ready" : ""}`}>
                            <div className="pdf-card-media">
                              <div className="pdf-sheet-illustration">
                                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <polyline points="14 2 14 8 20 8" />
                                  <line x1="16" y1="13" x2="8" y2="13" />
                                  <line x1="16" y1="17" x2="8" y2="17" />
                                  <line x1="10" y1="9" x2="8" y2="9" />
                                </svg>
                                {isScanning && <div className="pdf-scan-light-sweep"></div>}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* File Details & Dynamic Processing Stages */}
                        <div className="file-process-meta-area">
                          <div className="file-title-row">
                            <span className="file-chip-badge">{m.fileInfo.type}</span>
                            <span className="file-title-text" title={m.fileInfo.name}>
                              {m.fileInfo.name}
                            </span>
                            <span className="file-size-muted">{formatSize(m.fileInfo.size)}</span>
                          </div>

                          {/* Dynamic Processing Status Indicator */}
                          <div className="stage-status-row">
                            {isScanning && (
                              <div className="active-stage-indicator">
                                <span className="radar-pulse-dot"></span>
                                <span className="stage-text-label">{m.stageText || "Reading content…"}</span>
                              </div>
                            )}

                            {isDone && (
                              <div className="ready-stage-indicator">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span className="stage-text-success">Document ready</span>
                              </div>
                            )}

                            {isFail && (
                              <div className="fail-stage-indicator">
                                <span className="fail-dot"></span>
                                <span className="stage-text-fail">Processing failed</span>
                                {m.fileId && (
                                  <button
                                    className="retry-process-btn"
                                    onClick={() => handleRetryProcessing(m.id, m.fileId, m.fileInfo.name)}
                                  >
                                    Retry
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Optional Expandable Processing Details (Internal info hidden by default) */}
                            {isDone && (
                              <button
                                className="details-toggle-link"
                                onClick={() => toggleDetails(m.id)}
                              >
                                {detailsOpen[m.id] ? "Hide info" : "Processing details"}
                              </button>
                            )}
                          </div>

                          {/* Expandable Processing Details Content */}
                          {detailsOpen[m.id] && isDone && (
                            <div className="processing-details-panel">
                              <div className="detail-row">
                                <span className="detail-label">Status:</span>
                                <span className="detail-value">Completed & Indexed</span>
                              </div>
                              <div className="detail-row">
                                <span className="detail-label">Language:</span>
                                <span className="detail-value">
                                  {m.fileInfo.detected_language?.toUpperCase() || "Auto-detected"}
                                </span>
                              </div>
                              <div className="detail-row">
                                <span className="detail-label">Context:</span>
                                <span className="detail-value">Ready for natural questions</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Confirmation text once indexed */}
                        {m.text && isDone && (
                          <div className="post-upload-text">{m.text}</div>
                        )}
                        {m.text && isFail && (
                          <div className="post-upload-fail-text">{m.text}</div>
                        )}
                      </div>
                    </div>
                  );
                }

                // Assistant Regular Message
                return (
                  <div key={m.id} className="message-turn assistant-turn">
                    <AssistantMark />
                    <div className={`assistant-body ${m.isError ? "error-body" : ""}`}>
                      {m.isError && (
                        <div className="error-label">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                          </svg>
                          <span>Something went wrong</span>
                        </div>
                      )}
                      {m.isError ? (
                        <div className="assistant-text-content">{m.text}</div>
                      ) : (
                        <StreamedText
                          text={m.text || ""}
                          animate={Boolean(m.animate)}
                          onTick={() => messagesEndRef.current?.scrollIntoView({ block: "end" })}
                        />
                      )}

                      {/* Optional Collapsed Citations */}
                      {m.sources && m.sources.length > 0 && (
                        <div className="sources-collapsible">
                          <button
                            className="sources-toggle-btn"
                            onClick={() => toggleDetails(`src-${m.id}`)}
                          >
                            <span>Sources ({m.sources.length})</span>
                            <svg
                              className={`chevron-icon ${detailsOpen[`src-${m.id}`] ? "rotated" : ""}`}
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>

                          {detailsOpen[`src-${m.id}`] && (
                            <div className="sources-drawer">
                              {m.sources.map((s, idx) => (
                                <div key={idx} className="source-item">
                                  <div className="source-meta">
                                    <span className="source-file">{s.filename}</span>
                                    <span className="source-page">Page {s.page_number}</span>
                                  </div>
                                  <p className="source-quote">{s.text}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {!m.isError && (
                        <div className="assistant-footer-actions">
                          <button
                            className="copy-btn"
                            onClick={() => handleCopy(m.text, m.id)}
                            title="Copy message"
                          >
                            {copiedId === m.id ? (
                              <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {/* Answer Generating Thinking State */}
            {loading && <ThinkingIndicator hasDocument={Boolean(activeFile)} />}

            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Floating Chat Input Area */}
        <div className="chat-input-wrapper">
          <div className="chat-input-box">
            {/* Active File Chip inside input bar */}
            {activeFile && (
              <div className="input-active-file-chip">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="chip-name">{activeFile.filename}</span>
                <button
                  className="chip-remove-btn"
                  onClick={handleDetach}
                  title="Detach document (Switch to normal chat)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>
            )}

            <div className="input-row">
              {/* Paperclip File Upload Button */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.pdf"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleUploadFile(e.target.files[0]);
                  }
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="attach-file-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || loading}
                title="Attach PDF or image"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>

              {/* Text Input Area */}
              <textarea
                ref={textareaRef}
                className="chat-textarea"
                rows={1}
                value={input}
                placeholder={
                  activeFile
                    ? `Ask about ${activeFile.filename}…`
                    : "Message or attach a document…"
                }
                onChange={handleInputChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />

              {/* Send Button */}
              <button
                type="button"
                className="send-message-btn"
                disabled={loading || uploading || !input.trim()}
                onClick={() => handleSend()}
                title="Send"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>

          <div className="input-footer-text">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line · PDF, PNG, JPG up to 10 MB
          </div>
        </div>
      </div>
    </div>
  );
}
