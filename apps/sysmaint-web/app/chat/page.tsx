"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "bot";
  text: string;
};

const readyPrompts = [
  "System status summary in one line.",
  "Are there any active anomalies right now?",
  "Show CPU and memory trend for the last 30 minutes.",
  "Is the relay queue healthy? If not, what should I check first?",
  "Give me a high-severity incident checklist for this stack.",
  "Summarize relay health in 3 bullets with exact numbers.",
  "Compare now vs 10 minutes ago for CPU, memory, and queue depth.",
  "If we are degraded, give top 3 likely causes in priority order.",
  "Recommend immediate commands to validate relay and websocket health.",
  "Estimate user impact right now: none, low, medium, or high, and why.",
  "Create a 5-minute triage plan with concrete checks and expected outcomes.",
  "Explain any queue growth pattern and what threshold should trigger an alert.",
  "Give a rollback-safe mitigation plan if memory keeps rising for 15 more minutes.",
  "Return status in JSON with fields: health, cpuPct, memPct, queue, activeWs, action."
];

export default function ChatPage() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chatLogRef.current) return;
    chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [messages]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;

    const userMessage: ChatMessage = {
      id: `u:${Date.now()}`,
      role: "user",
      text: trimmed
    };
    setMessages((prev) => [...prev, userMessage]);
    setPrompt("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${text}`);
      }

      const payload = (await res.json()) as { reply: string; requestId: string };
      setMessages((prev) => [
        ...prev,
        {
          id: `b:${payload.requestId}`,
          role: "bot",
          text: payload.reply
        }
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e:${Date.now()}`,
          role: "bot",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat-wrap">
      <h1>Alice ↔ SysMaint (Signal E2EE)</h1>
      <p className="sub">Prompts and replies are transported as Signal-encrypted envelopes through the relay.</p>
      <div className="chat-log" ref={chatLogRef}>
        {messages.length === 0 ? <div className="sub">No messages yet.</div> : null}
        {messages.map((msg) => (
          <div key={msg.id} className={`msg ${msg.role}`}>
            <strong>{msg.role === "user" ? "Alice" : "SysMaint"}:</strong> {msg.text}
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit}>
        <div className="quick-prompts">
          {readyPrompts.map((template) => (
            <button
              key={template}
              type="button"
              className="quick-btn"
              onClick={() => setPrompt(template)}
              disabled={busy}
            >
              {template}
            </button>
          ))}
        </div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask for system status, trends, anomalies, queue state..."
        />
        <div style={{ marginTop: 10 }}>
          <button type="submit" disabled={busy || prompt.trim().length === 0}>
            {busy ? "Waiting for encrypted reply..." : "Send via Signal"}
          </button>
        </div>
      </form>
    </section>
  );
}
