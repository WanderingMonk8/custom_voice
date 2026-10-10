// src/frontend.ts
var VOICE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
`;
async function listAllTtsConnections() {
  const pageSize = 200;
  const connections = [];
  let offset = 0;
  while (true) {
    const response = await fetch(`/api/v1/tts-connections?limit=${pageSize}&offset=${offset}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Could not load TTS connections (${response.status}).`);
    const page = await response.json();
    const items = Array.isArray(page.data) ? page.data : [];
    connections.push(...items);
    offset += items.length;
    if (items.length === 0 || offset >= (page.total ?? items.length)) break;
  }
  return connections;
}
function setup(ctx) {
  const removeStyle = ctx.dom.addStyle(`
    .chat-voice-panel {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
    }
    .chat-voice-context {
      min-height: 18px;
      color: var(--lumiverse-text-muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .chat-voice-field {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .chat-voice-label {
      color: var(--lumiverse-text);
      font-size: 12px;
      font-weight: 600;
    }
    .chat-voice-actions {
      display: flex;
      gap: 8px;
    }
    .chat-voice-button {
      min-height: 36px;
      padding: 0 14px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-primary);
      color: var(--lumiverse-primary-foreground, white);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .chat-voice-button:disabled {
      cursor: not-allowed;
      opacity: .55;
    }
    .chat-voice-status {
      min-height: 18px;
      color: var(--lumiverse-text-muted);
      font-size: 12px;
    }
    .chat-voice-status[data-error="true"] {
      color: var(--lumiverse-danger, #ef6464);
    }
  `);
  const tab = ctx.ui.registerDrawerTab({
    id: "chat-voice",
    title: "Chat Voice",
    shortName: "Voice",
    headerTitle: "Chat Voice",
    description: "Set the TTS connection and custom voice for the active chat",
    keywords: ["tts", "speech", "audio", "custom voice"],
    iconSvg: VOICE_ICON
  });
  const panel = document.createElement("div");
  panel.className = "chat-voice-panel";
  const context = document.createElement("div");
  context.className = "chat-voice-context";
  context.textContent = "Open a chat to choose its voice.";
  const connectionField = document.createElement("div");
  connectionField.className = "chat-voice-field";
  const connectionLabel = document.createElement("div");
  connectionLabel.className = "chat-voice-label";
  connectionLabel.textContent = "TTS connection";
  const connectionSlot = document.createElement("div");
  connectionField.append(connectionLabel, connectionSlot);
  const voiceField = document.createElement("div");
  voiceField.className = "chat-voice-field";
  const voiceLabel = document.createElement("div");
  voiceLabel.className = "chat-voice-label";
  voiceLabel.textContent = "Custom voice name";
  const voiceSlot = document.createElement("div");
  voiceField.append(voiceLabel, voiceSlot);
  const actions = document.createElement("div");
  actions.className = "chat-voice-actions";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "chat-voice-button";
  saveButton.textContent = "Save for this chat";
  saveButton.disabled = true;
  actions.appendChild(saveButton);
  const status = document.createElement("div");
  status.className = "chat-voice-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(context, connectionField, voiceField, actions, status);
  tab.root.appendChild(panel);
  const connectionPicker = ctx.components.mountSelect(connectionSlot, {
    value: "",
    options: [],
    placeholder: "Loading connections\u2026",
    searchPlaceholder: "Search TTS connections\u2026",
    emptyMessage: "No TTS connections found.",
    clearable: true,
    clearLabel: "Use Lumiverse defaults",
    ariaLabel: "TTS connection",
    disabled: true
  });
  const voiceInput = ctx.components.mountTextInput(voiceSlot, {
    value: "",
    placeholder: "Enter the provider voice name or ID",
    ariaLabel: "Custom voice name",
    disabled: true
  });
  let activeChatId = null;
  let connectionsLoaded = false;
  function setStatus(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }
  async function loadConnections() {
    connectionPicker.update({ disabled: true, placeholder: "Loading connections\u2026" });
    try {
      const connections = await listAllTtsConnections();
      connectionsLoaded = true;
      connectionPicker.update({
        options: connections.map((connection) => ({
          value: connection.id,
          label: connection.name,
          sublabel: connection.provider
        })),
        placeholder: connections.length > 0 ? "Choose a TTS connection" : "No TTS connections found",
        disabled: !activeChatId || connections.length === 0
      });
      if (connections.length === 0) {
        setStatus("Create a TTS connection in Lumiverse first.");
      } else if (!activeChatId) {
        setStatus("Open a chat to edit its voice.");
      } else {
        setStatus("");
      }
    } catch (error) {
      connectionsLoaded = false;
      const message = error instanceof Error ? error.message : "Could not load TTS connections.";
      connectionPicker.update({ placeholder: "Connections unavailable", disabled: true });
      setStatus(message, true);
    }
  }
  function renderState(payload) {
    const chat = payload.chat;
    activeChatId = chat?.id ?? null;
    context.textContent = chat ? `Active chat: ${chat.name}` : "Open a chat to choose its voice.";
    connectionPicker.update({
      value: chat?.connectionId ?? "",
      disabled: !chat || !connectionsLoaded
    });
    voiceInput.update({
      value: chat?.voice ?? "",
      disabled: !chat
    });
    saveButton.disabled = !chat;
    if (chat?.mixed) {
      setStatus("This chat currently uses multiple voice overrides. Saving will replace them with one voice.");
    } else if (!chat) {
      setStatus("Open a chat to edit its voice.");
    } else {
      setStatus("");
    }
  }
  saveButton.addEventListener("click", () => {
    if (!activeChatId) return;
    saveButton.disabled = true;
    setStatus("Saving\u2026");
    ctx.sendToBackend({
      type: "chat_voice_save",
      connectionId: connectionPicker.getValue(),
      voice: voiceInput.getValue()
    });
  });
  const unsubscribeBackend = ctx.onBackendMessage((rawPayload) => {
    const payload = rawPayload;
    if (payload.type === "chat_voice_state") {
      renderState(payload);
    } else if (payload.type === "chat_voice_error") {
      saveButton.disabled = !activeChatId;
      setStatus(payload.error || "Could not update the chat voice.", true);
    }
  });
  const unsubscribeActivate = tab.onActivate(() => {
    void loadConnections();
    ctx.sendToBackend({ type: "chat_voice_refresh" });
  });
  void loadConnections();
  ctx.sendToBackend({ type: "chat_voice_refresh" });
  return () => {
    unsubscribeActivate();
    unsubscribeBackend();
    connectionPicker.destroy();
    voiceInput.destroy();
    tab.destroy();
    removeStyle();
  };
}
export {
  setup
};
